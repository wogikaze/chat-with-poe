import test from "node:test";
import assert from "node:assert/strict";
import { ConversationCoordinator } from "../tools/conversation-coordinator.js";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function create(options = {}) {
    return new ConversationCoordinator({ quietMs: 5, maxWaitMs: 25, shouldReply: async () => true,
        generate: async batch => batch.join(","), deliver: async () => {}, onError: error => { throw error; }, ...options });
}

test("bursts are collected before one generation", async () => {
    const generated = [], delivered = [];
    const c = create({ generate: async batch => { generated.push(batch); return "answer"; }, deliver: async (_, answer) => delivered.push(answer) });
    c.submit("channel:user", "first");
    c.submit("channel:user", "second");
    await sleep(15);
    await c.close();
    assert.deepEqual(generated, [["first", "second"]]);
    assert.deepEqual(delivered, ["answer"]);
});

test("continuous arrivals hit the hard deadline", async () => {
    const started = deferred();
    const c = create({ quietMs: 100, maxWaitMs: 20, generate: async () => { started.resolve(); return "answer"; } });
    c.submit("key", 0);
    const interval = setInterval(() => c.submit("key", 1), 2);
    try {
        await Promise.race([started.promise, sleep(120).then(() => { throw new Error("deadline never fired"); })]);
    } finally { clearInterval(interval); await c.close(); }
});

test("only one revision precedes delivery; later arrivals become a new batch", async () => {
    const releases = [deferred(), deferred(), deferred()];
    const starts = [deferred(), deferred(), deferred()];
    const batches = [], sent = [];
    const c = create({ generate: async batch => {
        const i = batches.length; batches.push(batch); starts[i].resolve(); await releases[i].promise; return `answer-${i}`;
    }, deliver: async (_, answer) => sent.push(answer) });
    c.submit("key", "a"); await starts[0].promise;
    c.submit("key", "b"); releases[0].resolve(); await starts[1].promise;
    c.submit("key", "c"); releases[1].resolve(); await starts[2].promise;
    assert.deepEqual(sent, ["answer-1"]);
    releases[2].resolve(); await c.close();
    assert.deepEqual(batches, [["a"], ["a", "b"], ["c"]]);
    assert.deepEqual(sent, ["answer-1", "answer-2"]);
});

test("suppression cancels the in-flight reply and pending messages", async () => {
    const release = deferred(), start = deferred(); let sent = 0;
    const c = create({ generate: async () => { start.resolve(); await release.promise; return "draft"; }, deliver: async () => { sent++; } });
    c.submit("key", "a"); await start.promise; c.submit("key", "b"); c.suppress("key"); release.resolve();
    await c.close(); assert.equal(sent, 0);
});

test("conversation and pending-message counts are bounded", async () => {
    const c = create({ maxConversations: 1, maxBatchMessages: 2, quietMs: 100 });
    assert.equal(c.submit("one", 1), true);
    assert.equal(c.submit("two", 1), false);
    assert.equal(c.submit("one", 2), true);
    assert.equal(c.submit("one", 3), false);
    await c.close();
});

test("failure of one batch does not discard posts accepted during generation", async () => {
    const start = deferred(), release = deferred(); let calls = 0;
    const errors = [], sent = [];
    const c = create({ generate: async batch => {
        if (calls++ === 0) { start.resolve(); await release.promise; throw new Error('dummy failure'); }
        return batch.join(',');
    }, deliver: async (_, answer) => sent.push(answer), onError: async error => errors.push(error) });
    c.submit('key', 'a'); await start.promise; c.submit('key', 'b'); release.resolve(); await c.close();
    assert.equal(errors.length, 1);
    assert.deepEqual(sent, ['b']);
});
