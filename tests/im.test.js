import test from "node:test";
import assert from "node:assert/strict";
import { createImService, DEFAULT_IM_MODEL, DEFAULT_IM_FALLBACK_MODEL, formatImError } from "../tools/im-service.js";
import { createMessageDispatcher, parseImMessage } from "../tools/message-dispatcher.js";
import { ConversationCoordinator } from "../tools/conversation-coordinator.js";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function message(content) {
    return { content, channelId: "channel", channel: {}, author: { id: "user", bot: false },
        mentions: { has: () => true, users: new Map() } };
}

test("IM uses its lightweight model and sends only the conversion input", async () => {
    let request;
    const service = createImService({ complete: async input => { request = input; return "今日は晴れです"; } });
    assert.equal(await service.convert("kyou wa hare desu"), "今日は晴れです");
    assert.equal(request.model, DEFAULT_IM_MODEL);
    assert.equal(request.messages.length, 2);
    assert.deepEqual(request.messages[1], { role: "user", content: "kyou wa hare desu" });
    assert.ok(request.maxTokens <= 2048);
    assert.ok(!JSON.stringify(request.messages).includes("Reviewed shared memories"));
    service.close();
});

test("two conversions start before either finishes and their results stay separate", async () => {
    const jobs = [deferred(), deferred()]; const started = [];
    const service = createImService({ complete: input => { const i = started.length; started.push(input); return jobs[i].promise; } });
    const first = service.convert("first"), second = service.convert("second");
    await tick(); assert.equal(started.length, 2);
    jobs[1].resolve("二番目"); assert.equal(await second, "二番目");
    jobs[0].resolve("一番目"); assert.equal(await first, "一番目"); service.close();
});

test("concurrency is bounded and overload fails immediately", async () => {
    const job = deferred();
    const service = createImService({ maxConcurrent: 1, complete: () => job.promise });
    const first = service.convert("first");
    await assert.rejects(service.convert("second"), error => error.code === "IM_BUSY");
    job.resolve("変換済み"); await first; service.close();
});

test("deadline aborts the request and releases the slot", async () => {
    let signal;
    const service = createImService({ timeoutMs: 10, maxConcurrent: 1, complete: input => {
        signal = input.signal; return input.messages[1].content === "stall" ? new Promise(() => {}) : Promise.resolve("成功");
    } });
    await assert.rejects(service.convert("stall"), error => error.code === "IM_TIMEOUT");
    assert.equal(signal.aborted, true);
    assert.equal(await service.convert("next"), "成功"); service.close();
});

test("closing aborts in-flight IM requests and stops admission", async () => {
    const started = deferred();
    const service = createImService({ complete: () => { started.resolve(); return new Promise(() => {}); } });
    const work = service.convert("pending"); await started.promise; service.close();
    await assert.rejects(work, error => error.code === "IM_CLOSED");
    await assert.rejects(service.convert("new"), error => error.code === "IM_CLOSED");
});

test("busy Gemma switches to Flash-Lite and stays there during the cooldown", async () => {
    const models = []; let now = 1000;
    const service = createImService({ now: () => now, fallbackCooldownMs: 100,
        complete: async input => { models.push(input.model);
            if (input.model === DEFAULT_IM_MODEL) throw Object.assign(new Error("429"), { status: 429 });
            return "成功";
        } });
    assert.equal(await service.convert("one"), "成功");
    assert.equal(await service.convert("two"), "成功");
    assert.deepEqual(models, [DEFAULT_IM_MODEL, DEFAULT_IM_FALLBACK_MODEL, DEFAULT_IM_FALLBACK_MODEL]);
    assert.equal(service.activeModel, DEFAULT_IM_FALLBACK_MODEL);
    now += 100; await service.convert("three");
    assert.equal(models[3], DEFAULT_IM_MODEL); service.close();
});

test("fallback shares the original deadline and never falls back to the conversation model", async () => {
    const models = [];
    const service = createImService({ timeoutMs: 15, complete: async input => {
        models.push(input.model);
        if (models.length === 1) throw Object.assign(new Error("429"), { status: 429 });
        return new Promise(() => {});
    } });
    await assert.rejects(service.convert("dummy"), error => error.code === "IM_TIMEOUT");
    assert.deepEqual(models, [DEFAULT_IM_MODEL, DEFAULT_IM_FALLBACK_MODEL]); service.close();
});

test("literal /im parser recognizes command boundaries and an optional bot mention", () => {
    assert.equal(parseImMessage("/im konnichiwa", "42"), "konnichiwa");
    assert.equal(parseImMessage("  <@42> /IM test", "42"), "test");
    assert.equal(parseImMessage("<@!42> /im test", "42"), "test");
    assert.equal(parseImMessage("/im", "42"), "");
    for (const content of ["/imakita", "/important", "talk about /im", "<@99> /im test"]) assert.equal(parseImMessage(content, "42"), null);
});

test("plain /im completes while the same author's ordinary reply is still generating", async () => {
    const start = deferred(), release = deferred(), sent = []; let generated = 0, typing = 0;
    const coordinator = new ConversationCoordinator({ quietMs: 0, maxWaitMs: 0,
        shouldReply: async () => true, generate: async () => { generated++; start.resolve(); await release.promise; return "通常回答"; },
        deliver: async (_, text) => sent.push(text), onError: error => { throw error; } });
    const service = createImService({ complete: async () => "今日は晴れです" });
    const dispatch = createMessageDispatcher({ getBotUser: () => ({ id: "42" }), isClosing: () => false,
        coordinator, imService: service, startTyping: () => { typing++; return () => { typing--; }; },
        reply: async (_, text) => sent.push(text) });
    dispatch(message("普通の質問")); await start.promise;
    await dispatch(message("/im kyou wa hare desu"));
    assert.deepEqual(sent, ["今日は晴れです"]);
    assert.equal(generated, 1); assert.equal(typing, 0);
    release.resolve(); await coordinator.close(); service.close();
    assert.deepEqual(sent, ["今日は晴れです", "通常回答"]);
    assert.equal(generated, 1, "IM must not trigger revision of the ordinary answer");
});

test("empty IM does not call the model and errors do not expose upstream text", async () => {
    let calls = 0; const sent = [];
    const dispatch = createMessageDispatcher({ getBotUser: () => ({ id: "42" }), isClosing: () => false,
        coordinator: { submit: () => { throw new Error("IM entered conversation queue"); } },
        imService: { convert: async () => { calls++; throw new Error("DUMMY_SECRET"); } },
        startTyping: () => () => {}, reply: async (_, text) => sent.push(text) });
    await dispatch(message("/im")); assert.equal(calls, 0);
    await dispatch(message("/im test")); assert.equal(calls, 1);
    assert.ok(sent.every(text => !text.includes("DUMMY_SECRET")));
    assert.ok(!formatImError(new Error("DUMMY_SECRET")).includes("DUMMY_SECRET"));
});
