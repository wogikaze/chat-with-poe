import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class MemoryStore {
    constructor(filename, { now = Date.now } = {}) {
        this.now = now;
        mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        this.writer = new DatabaseSync(filename);
        chmodSync(filename, 0o600);
        this.writer.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, topic TEXT NOT NULL, statement TEXT NOT NULL,
                source_message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
                reviewed_at INTEGER NOT NULL, review_after INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS memories_review_after ON memories(review_after);`);
        this.reader = new DatabaseSync(filename, { readOnly: true });
        this.reader.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
        this.writes = Promise.resolve();
    }

    saveApproved(candidate) {
        const task = this.writes.then(() => {
            const now = this.now();
            const id = createHash("sha256").update(`${candidate.subject_id}\n${candidate.topic}`).digest("hex");
            this.writer.exec("BEGIN IMMEDIATE");
            try {
                this.writer.prepare(`INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET statement=excluded.statement, source_message_id=excluded.source_message_id,
                    reviewed_at=excluded.reviewed_at, review_after=excluded.review_after`)
                    .run(id, candidate.subject_id, candidate.topic, candidate.statement, candidate.evidence_message_id,
                        now, now, now + THIRTY_DAYS_MS);
                this.writer.prepare("DELETE FROM memories WHERE review_after <= ?").run(now);
                this.writer.exec(`DELETE FROM memories WHERE id IN
                    (SELECT id FROM memories ORDER BY reviewed_at DESC, id LIMIT -1 OFFSET 5000)`);
                this.writer.exec("COMMIT");
            } catch (error) {
                this.writer.exec("ROLLBACK");
                throw error;
            }
        });
        this.writes = task.catch(() => {});
        return task;
    }

    existingTopics(subjectIds) {
        const subjects = [...new Set(subjectIds)];
        if (!subjects.length) return [];
        const placeholders = subjects.map(() => "?").join(",");
        return this.reader.prepare(`SELECT subject_id, topic, statement FROM memories
            WHERE review_after > ? AND subject_id IN (${placeholders}) ORDER BY reviewed_at DESC LIMIT 64`)
            .all(this.now(), ...subjects);
    }

    relevant(query, requesterId, limit = 5) {
        // Hiragana function words do not count as relevance signals.
        const tokens = [...new Set((query.normalize("NFKC").toLowerCase()
            .match(/[\p{Script=Han}]{2,}|[\p{Script=Katakana}ー]{2,}|[a-z0-9_]{2,}/gu) || []))];
        return this.reader.prepare("SELECT * FROM memories WHERE review_after > ? ORDER BY reviewed_at DESC, id LIMIT 5000")
            .all(this.now()).map(row => {
                const statement = row.statement.normalize("NFKC").toLowerCase();
                const score = tokens.reduce((total, token) => total + (statement.includes(token) ? token.length : 0), 0)
                    + (row.subject_id === requesterId ? 1 : 0);
                return { row, score };
            }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.row.reviewed_at - a.row.reviewed_at)
            .slice(0, limit).map(({ row }) => ({ subject_id: row.subject_id, statement: row.statement,
                source_message_id: row.source_message_id, reviewed_at: row.reviewed_at, review_after: row.review_after }));
    }

    async close() {
        await this.writes;
        this.reader.close();
        this.writer.close();
    }
}
