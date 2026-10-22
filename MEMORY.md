# Reviewed shared Discord memory

Memory remains shared across every user, channel and server using this bot. Facts retain the source author's Discord ID and source message ID. Sharing includes facts extracted from nearby conversation, not only the current requester. See README.md for the privacy implications.

After a reply is delivered, a bounded background worker extracts at most three durable memory candidates from text records (no image bytes). Each candidate must cite an exact quote in a supplied message and identify that message's author. A separate fresh DSH session independently reviews the evidence, attribution, durability and sensitivity. Only an explicit JSON `approved: true` verdict allows a write. Malformed responses, missing evidence, rejections and provider failures produce no memory writes. Queue overflow skips memory extraction; it does not block the answer.

Approved memories are stored in `data/memory.sqlite`. One SQLite writer serializes `BEGIN IMMEDIATE` transactions; a separate read-only connection queries in WAL mode. A stable subject/topic key lets an approved correction replace the previous fact. At most 5,000 memories are retained, and at most five relevant memories are supplied to an answer. Matching uses meaningful kanji, katakana and alphanumeric tokens instead of common hiragana bigrams; requester-attributed facts can also be recalled.

Each approval records `reviewed_at` and `review_after` (30 days later). Memories at or beyond `review_after` are excluded from retrieval, even if they are still on disk. They are not automatically renewed without another evidence extraction and independent approval. This is an injection expiry, not a promise to delete every original message or DSH session log.

The legacy `dsh-auto-memory` plugin is disabled by the DSH patch so its unreviewed Markdown memories cannot bypass this policy. Existing files under `DSH_HOME/memory` are preserved but are not automatically imported or injected. New answers and memory reviews use fresh DSH sessions so expired injected memories do not remain in a reused model session. Recent conversational context comes from the explicit Discord message batch and nearby messages; `/chat` includes its current request and relevant reviewed memories.

Independent review is a separate model session, not a different provider or a guarantee of factual correctness. It adds background model calls and can fail closed during provider outages. The default runtime uses the DSH installed in this project's node_modules; a custom `DSH_BIN` is an operator-managed runtime override.
