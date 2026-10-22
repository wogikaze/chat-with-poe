import test from "node:test";
import assert from "node:assert/strict";
import { nextFence, splitDiscordMessage, replyToInteraction, replyToMessage } from "../tools/delivery.js";

function assertValid(chunks, limit) {
    for (const chunk of chunks) {
        assert.ok(chunk.length <= limit, `oversized chunk: ${chunk.length}`);
        assert.ok(chunk.isWellFormed(), "split surrogate pair");
        let fence = null;
        for (const line of chunk.match(/[^\n]*\n|[^\n]+$/g) || []) fence = nextFence(line, fence);
        assert.equal(fence, null, "unclosed fence");
    }
}

test("plain text and emoji retain every code point at the UTF-16 boundary", () => {
    for (const input of ["a".repeat(1999) + "😀".repeat(3000), "🧑🏽‍💻\n".repeat(1400), "short text"]) {
        const chunks = splitDiscordMessage(input);
        assertValid(chunks, 2000);
        assert.equal(chunks.join(""), input);
    }
});

test("long code lines are closed and reopened with their language", () => {
    const body = "😀".repeat(5000);
    const chunks = splitDiscordMessage(`\`\`\`js\n${body}\n\`\`\``);
    assertValid(chunks, 2000);
    assert.ok(chunks.every(chunk => chunk.startsWith("```js\n")));
    assert.ok(chunks.map(chunk => chunk.replace(/^```js\n/, "").replace(/\n```$/, "")).join("") === body, "code content changed");
});

test("four-backtick and tilde fences ignore shorter and inline markers", () => {
    const input = "inline `` ``` `` is prose\n````js\n" + ("```\n😀hello\n".repeat(100)) + "````\n~~~py\n" + "x".repeat(4000) + "\n~~~";
    assertValid(splitDiscordMessage(input), 2000);
    const outer = nextFence("````js\n", null);
    assert.equal(nextFence("```\n", outer), outer);
    assert.equal(nextFence("`````\n", outer), null);
    assert.equal(nextFence("inline ```\n", null), null);
});

test("an enormous fence is rejected rather than looping or exceeding Discord limits", () => {
    assert.throws(() => splitDiscordMessage("```" + "a".repeat(2000) + "\nx"), RangeError);
});

test("all interaction fragments stay ephemeral and disable mentions", async () => {
    const sent = [];
    await replyToInteraction({ ephemeral: true, editReply: async p => sent.push(p), followUp: async p => sent.push(p) }, "😀".repeat(2500));
    assert.equal(sent.length, 3);
    assert.ok(sent.slice(1).every(p => p.ephemeral === true));
    assert.ok(sent.every(p => p.allowedMentions.parse.length === 0));
});

test("message fragments cannot trigger user/role/everyone mentions", async () => {
    const sent = [];
    await replyToMessage({ reply: async p => sent.push(p), channel: { send: async p => sent.push(p) } }, "@everyone".repeat(500));
    assert.ok(sent.length > 1);
    assert.ok(sent.every(p => p.allowedMentions.parse.length === 0));
    assert.equal(sent[0].allowedMentions.repliedUser, false);
});
