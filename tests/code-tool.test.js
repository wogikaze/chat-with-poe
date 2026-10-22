import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../tools/dsh-code-tool.js";

function registeredTool() {
    let tool;
    apply({ tools: { register(value) { tool = value; } } });
    return tool;
}

test("conversation execution rejects unsupported languages and missing source before running", async () => {
    const tool = registeredTool();
    await assert.rejects(() => tool.execute({ language: "host-shell", source: "echo test" }, {}));
    await assert.rejects(() => tool.execute({ language: "c" }, {}));
});

test("conversation execution enforces the shared UTF-8 source limit", async () => {
    const tool = registeredTool();
    const result = await tool.execute({ language: "c", source: "あ".repeat(11000) }, {});
    assert.equal(result.ok, false);
    assert.match(result.error, /32768 bytes/);
});

test("an already cancelled conversation cannot start code execution", async () => {
    const tool = registeredTool();
    await assert.rejects(() => tool.execute({ language: "c", source: "int main(void) {return 0;}" }, {
        signal: AbortSignal.abort(),
    }), { name: "AbortError" });
});
