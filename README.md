# Chat with Poe

Discord bot powered by DeepSeek Harness and Google Vertex AI.

## Persistent memory and privacy

The reviewed memory store is shared across every Discord user, server, channel, and session that uses this bot. Information from one conversation may therefore affect answers in another conversation. Do not use this bot for confidential or sensitive conversations unless that sharing is acceptable to everyone involved.

The bot also sends conversation context to the configured Google Vertex AI model when generating or classifying replies. Configure access to the bot and its channel permissions with that data flow in mind.

## Fast IM conversion

`/im text:<romanized Japanese>` and plain messages starting with `/im ` use a dedicated lightweight API path. A leading mention of this bot is also supported. The primary model is `google/gemma-4-26b-a4b-it-maas` (thinking disabled). When it returns an availability/access error such as HTTP 429, conversion switches to `gemini-3.1-flash-lite` with minimal thinking. The primary is skipped for 60 seconds after such a failure. Neither path uses the large conversation model.

Conversions call Google Vertex directly using the existing ADC configuration. They send the IME instructions, input text, and up to eight preceding messages from the same channel as reference context (plus a cached reply target, when available). History retrieval waits at most one second and falls back to the channel cache. Each reference is limited to 2,000 UTF-16 code units, with truncation marked; unavailable or omitted text must not be invented. Context is separate from the text being converted. Images and shared memories are not loaded. IM does not join the ordinary message batch, revise a pending answer, or wait for a DSH subprocess. Up to four conversions run in parallel with each other and ordinary chat; excess requests receive a busy response immediately. The default 15-second deadline covers authentication, the API call and any fallback together. Input is limited to 4,000 UTF-16 code units.

Math expressions use Unicode/plain text rather than LaTeX: for example, `∫[0, π/2] x⁵ cos x dx` and `(x²+1)/2`. The converter preserves existing Japanese and English names such as `Euler's formula`, and does not solve or reinterpret the expression. If a response still contains TeX commands or math delimiters, it gets at most one formatting repair on the same lightweight model path, within the original request deadline. A second malformed result is not sent to Discord. Normal conversions still use one model call.

Configure `IM_MODEL`, `IM_FALLBACK_MODEL`, `IM_VERTEX_LOCATION`, `IM_MAX_CONCURRENT` (1–16) and `IM_TIMEOUT_MS` (1,000–60,000) in `.env` if needed. Defaults are shown in `.env.example`; an empty `IM_FALLBACK_MODEL` disables fallback. Model availability, quota and end-to-end response time still depend on Google Cloud.

## Setup

Use Node.js 22.19.0 or later (including its built-in SQLite module). Check `node --version` when working in a shell.

Copy `.env.example` to `.env`, fill in the Discord bot token and Google Cloud settings, then run `npm install` and `npm run setup:dsh`. Start the bot with `node index.js`.

The lockfile includes patched transitive dependencies; overrides pin the MCP client and fflate security fixes. Custom DSH runtimes outside this project must be maintained separately.

`npm test` runs offline regression tests for batching, delivery boundaries, error sanitization and reviewed memory persistence.

Memory now uses a SQLite writer/read-only WAL reader pair, independent AI review, and a 30-day injection expiry. Legacy Markdown memories are preserved but not automatically imported; see [MEMORY.md](MEMORY.md).

See [AUTO_REPLY.md](AUTO_REPLY.md), [CODE_EXECUTION.md](CODE_EXECUTION.md), and [MEMORY.md](MEMORY.md) for feature details.
