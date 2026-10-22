import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../tools/memory-store.js";
import { MemoryService } from "../tools/memory-service.js";

async function fixture(t, options) {
    const dir = await mkdtemp(path.join(tmpdir(), "poe-memory-test-"));
    const file = path.join(dir, "memory.sqlite");
    const store = new MemoryStore(file, options);
    t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
    return { store, file };
}
const candidate = { subject_id: "alice", topic: "preferred-language", statement: "alice prefers Python", evidence_message_id: "message-1", evidence_quote: "prefers Python" };
const sources = [{ message_id: "message-1", author: { id: "alice", is_bot: false }, content: "alice prefers Python" }];

test("single writer uses WAL, read-only reader and concurrent writes stay consistent", async t => {
    const { store } = await fixture(t);
    assert.equal(store.writer.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.throws(() => store.reader.exec("DELETE FROM memories"));
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.saveApproved({ ...candidate, topic: `preference-${i}`, statement: `Python preference ${i}` })));
    assert.equal(store.reader.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 25);
    assert.equal(store.relevant("Python", "bob").length, 5);
});

test("review_after excludes a memory at exactly 30 days and persists across connections", async t => {
    let now = 1_000_000;
    const { store, file } = await fixture(t, { now: () => now });
    await store.saveApproved(candidate);
    const other = new MemoryStore(file, { now: () => now });
    assert.equal(other.relevant("Python", "bob").length, 1);
    now += 30 * 86400_000;
    assert.equal(store.relevant("Python", "alice").length, 0);
    assert.equal(other.relevant("Python", "alice").length, 0);
    await other.close();
});

test("general hiragana phrases do not retrieve unrelated shared memories", async t => {
    const { store } = await fixture(t);
    await store.saveApproved(candidate);
    assert.deepEqual(store.relevant("これはどうしていますか。ですます。", "bob"), []);
    assert.equal(store.relevant("Python", "bob").length, 1);
});

test("extraction and independent review use distinct sessions; rejection never writes", async t => {
    const { store } = await fixture(t); const calls = [];
    let approved = false;
    const service = new MemoryService({ store, run: async input => {
        calls.push(input);
        return input.sessionId.startsWith("memory-extract") ? JSON.stringify({ candidates: [candidate] }) : JSON.stringify({ approved });
    } });
    service.observe(sources); await service.work;
    assert.equal(store.relevant("Python", "bob").length, 0);
    approved = true; service.observe(sources); await service.work;
    assert.equal(store.relevant("Python", "bob").length, 1);
    assert.notEqual(calls[0].sessionId, calls[1].sessionId);
    assert.ok(calls[1].content.includes("Evidence:"));
    await service.close();
});

test("fabricated evidence or wrong author cannot reach the review/write path", async t => {
    const { store } = await fixture(t); let calls = 0;
    const service = new MemoryService({ store, run: async () => {
        calls++; return JSON.stringify({ candidates: [{ ...candidate, subject_id: "bob" }, { ...candidate, evidence_quote: "fabricated quote" }] });
    } });
    service.observe(sources); await service.work; await service.close();
    assert.equal(calls, 1);
    assert.equal(store.relevant("Python", "alice").length, 0);
});


test("a reviewed correction replaces its topic rather than retaining contradictory facts", async t => {
    const { store } = await fixture(t);
    await store.saveApproved(candidate);
    await store.saveApproved({ ...candidate, statement: "alice now prefers Rust" });
    const rows = store.relevant("language", "alice");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].statement, "alice now prefers Rust");
});

test("obvious credential text is excluded before model extraction", async t => {
    const { store } = await fixture(t); let calls = 0;
    const service = new MemoryService({ store, run: async () => { calls++; return '{}'; } });
    service.observe([{ ...sources[0], content: 'API_KEY=DUMMY_SECRET_VALUE' }]);
    await service.close();
    assert.equal(calls, 0);
    assert.equal(store.relevant('DUMMY', 'alice').length, 0);
});
