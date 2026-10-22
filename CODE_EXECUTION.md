# Code execution

`tools/run-code.js` contains an isolated code runner that accepts a language id and source code only. Discord users can invoke it with `/run language:<language> code:<source>`. It executes each run in a disposable, digest-pinned container with no network, a read-only root filesystem, UID 65534, no Linux capabilities, no-new-privileges, 768 MB memory, 1 CPU, a 32-process limit, a 20 CPU-second limit, a 45-second wall timeout, and a 512 MB writable `/tmp`. At most two runs execute concurrently; up to eight wait. External dependencies and downloads are disabled.

The runner is called directly by the `/run` slash command and exposed to ordinary conversations as the `execute_code` DSH tool (`tools/dsh-code-tool.js`). Both paths use the same language allowlist and container restrictions. The tool accepts only a language id and source text; models cannot supply container options or host commands. DSH's host shell and filesystem tools remain disabled.

The conversation prompt prioritizes running generated or corrected runnable code before answering, checking representative inputs and reporting the actual verification. Explicit requests not to execute are respected. Unsupported dependencies, interactive input, and environment limitations must be explained; adapted tests must be distinguished from the original program. Tool output is treated as untrusted data.

Language conventions: Java uses class `Main`; C# uses top-level statements in `Program.cs`; Scala uses a self-contained `Main.scala`; SQL runs on an in-memory SQLite database and prints rows returned by statements.
