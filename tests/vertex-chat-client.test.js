import test from "node:test";
import assert from "node:assert/strict";
import { createVertexChatClient } from "../tools/vertex-chat-client.js";
import { createImService } from "../tools/im-service.js";
const input = { model: "google/gemma-4-26b-a4b-it-maas", messages: [{ role: "system", content: "convert only" }, { role: "user", content: "dummy" }],
    maxTokens: 2048, signal: new AbortController().signal };
const auth = { getClient: async () => ({ getRequestHeaders: async () => new Headers({ authorization: "Bearer DUMMY_TOKEN" }) }) };
const success = text => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: text } }] }), { status: 200 });

test("Vertex uses global MaaS, ADC headers, non-thinking and no redirects", async () => {
    let seen;
    const complete = createVertexChatClient({ projectId: "test-project", auth, fetchImpl: async (url, options) => {
        seen = { url, options }; return success("変換済み");
    } });
    assert.equal(await complete(input), "変換済み");
    assert.equal(seen.url, "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi/chat/completions");
    assert.equal(seen.options.headers.get("authorization"), "Bearer DUMMY_TOKEN");
    assert.equal(seen.options.redirect, "error");
    assert.equal(seen.options.signal, input.signal);
    const body = JSON.parse(seen.options.body);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.equal(body.stream, false); assert.equal(body.max_tokens, 2048);
});

test("shared auth initialization does not serialize parallel API requests", async () => {
    let authCalls = 0, fetchCalls = 0; const releases = [];
    const complete = createVertexChatClient({ projectId: "test-project", auth: { getClient: async () => {
        authCalls++; return { getRequestHeaders: async () => ({}) };
    } }, fetchImpl: () => { fetchCalls++; return new Promise(resolve => releases.push(resolve)); } });
    const jobs = [complete(input), complete(input)];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(authCalls, 1); assert.equal(fetchCalls, 2);
    releases[0](success("一")); releases[1](success("二"));
    assert.deepEqual(await Promise.all(jobs), ["一", "二"]);
});

test("fallback Gemini uses its native API with minimal thinking", async () => {
    let seen;
    const complete = createVertexChatClient({ projectId: "test-project", auth, fetchImpl: async (url, options) => {
        seen = { url, options }; return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: {
            parts: [{ thought: true, text: "do not return thoughts" }, { text: "結果" }],
        } }] }), { status: 200 });
    } });
    assert.equal(await complete({ ...input, model: "gemini-3.1-flash-lite" }), "結果");
    assert.ok(seen.url.endsWith("/publishers/google/models/gemini-3.1-flash-lite:generateContent"));
    const body = JSON.parse(seen.options.body);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "MINIMAL");
    assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "dummy" }] }]);
});

test("HTTP failures do not expose response bodies or credentials", async () => {
    const complete = createVertexChatClient({ projectId: "test-project", auth,
        fetchImpl: async () => new Response("DUMMY_SECRET in upstream diagnostics", { status: 403 }) });
    await assert.rejects(complete(input), error => error.status === 403 && !/DUMMY_SECRET|DUMMY_TOKEN/.test(error.message));
});

test("a deadline during authentication cannot send a late model request", async () => {
    let release, fetchCalls = 0;
    const headers = new Promise(resolve => { release = resolve; });
    const complete = createVertexChatClient({ projectId: "test-project", auth: {
        getClient: async () => ({ getRequestHeaders: () => headers }),
    }, fetchImpl: async () => { fetchCalls++; return success("late"); } });
    const service = createImService({ complete, timeoutMs: 10 });
    await assert.rejects(service.convert("dummy"), error => error.code === "IM_TIMEOUT");
    release({}); await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetchCalls, 0); service.close();
});

test("truncated conversion results are rejected instead of silently returned", async () => {
    const complete = createVertexChatClient({ projectId: "test-project", auth,
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }), { status: 200 }) });
    await assert.rejects(complete(input), error => error.code === "IM_TRUNCATED");
});
