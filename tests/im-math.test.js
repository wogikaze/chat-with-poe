import test from "node:test";
import assert from "node:assert/strict";
import { buildImMessages, hasLatexMath } from "../tools/im-prompt.js";
import { createImService, DEFAULT_IM_MODEL, DEFAULT_IM_FALLBACK_MODEL, formatImError } from "../tools/im-service.js";
const reported = String.raw`$\int_{0}^{\pi/2} x^5 \text{ と } \cos x \text{ の積の微分}$ これを Euler's formula の性質として扱うことで3分で計算できるようになって激熱すぎる。控えめに言って神。`;
const expected = "∫[0, π/2] x⁵ と cos x の積の微分 これを Euler's formula の性質として扱うことで3分で計算できるようになって激熱すぎる。控えめに言って神。";

test("math policy contains actual TeX examples, Unicode alternatives and no-solving instructions", () => {
    const messages = buildImMessages(reported);
    assert.equal(messages[1].content, reported);
    assert.ok(messages[0].content.includes(String.raw`\int`));
    assert.ok(messages[0].content.includes("∫[0, π/2]"));
    assert.ok(messages[0].content.includes("x⁵"));
    assert.ok(messages[0].content.includes("数式を計算したり解説したりしない"));
});

test("unsupported math markup is detected while Unicode, plain math and prices are allowed", () => {
    for (const text of [reported, "$x$", "$$x$$", String.raw`\(x\)`, String.raw`\[x\]`, String.raw`\frac{a}{b}`, "x^{5}"]) {
        assert.equal(hasLatexMath(text), true);
    }
    for (const text of [expected, "(a+b)/(c+d)", "d/dx(x⁵ cos x)", "Euler's formula", "cost $10 and $20.", "echo $HOME and $PATH"]) {
        assert.equal(hasLatexMath(text), false);
    }
});

test("reported LaTeX output triggers just one repair with the original sentence preserved", async () => {
    const calls = [];
    const service = createImService({ complete: async input => {
        calls.push(input); return calls.length === 1 ? reported : expected;
    } });
    assert.equal(await service.convert(reported), expected);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].messages.map(message => message.role), ["system", "user", "assistant", "user"]);
    assert.equal(calls[1].messages[1].content, reported);
    assert.equal(calls[1].messages[2].content, reported);
    assert.ok(calls.every(input => input.model === DEFAULT_IM_MODEL));
    assert.equal(calls[0].signal, calls[1].signal);
    service.close();
});

test("an already-correct Unicode conversion takes one API call", async () => {
    let calls = 0;
    const service = createImService({ complete: async () => { calls++; return expected; } });
    assert.equal(await service.convert(reported), expected);
    assert.equal(calls, 1); service.close();
});

test("a second invalid result is rejected instead of returning raw TeX or retrying forever", async () => {
    let calls = 0;
    const service = createImService({ complete: async () => { calls++; return reported; } });
    await assert.rejects(service.convert(reported), error => error.code === "IM_FORMAT");
    assert.equal(calls, 2);
    assert.equal(hasLatexMath(formatImError({ code: "IM_FORMAT" })), false);
    service.close();
});

test("repair after a rate-limit fallback remains on the lightweight fallback model", async () => {
    const models = [];
    const service = createImService({ complete: async input => {
        models.push(input.model);
        if (input.model === DEFAULT_IM_MODEL) throw Object.assign(new Error("429"), { status: 429 });
        return models.length === 2 ? reported : expected;
    } });
    assert.equal(await service.convert(reported), expected);
    assert.deepEqual(models, [DEFAULT_IM_MODEL, DEFAULT_IM_FALLBACK_MODEL, DEFAULT_IM_FALLBACK_MODEL]);
    service.close();
});

test("a stalled repair shares the original deadline and is aborted", async () => {
    let calls = 0, signal;
    const service = createImService({ timeoutMs: 15, complete: async input => {
        calls++; signal = input.signal;
        return calls === 1 ? reported : new Promise(() => {});
    } });
    await assert.rejects(service.convert(reported), error => error.code === "IM_TIMEOUT");
    assert.equal(calls, 2); assert.equal(signal.aborted, true); service.close();
});
