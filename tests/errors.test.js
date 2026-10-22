import test from "node:test";
import assert from "node:assert/strict";
import { errorCategory, formatDshError, logError } from "../tools/errors.js";

test("upstream secrets, prompts and newlines never reach logs or public errors", () => {
    const outputs = []; const original = console.error;
    console.error = value => outputs.push(value);
    try {
        for (const detail of ["401 auth", "429 quota", "ETIMEDOUT", "TransportClosedError", "arbitrary failure"]) {
            const error = new Error(`${detail}\nAuthorization: Bearer DUMMY_SECRET prompt: DUMMY_PROMPT`);
            logError("request_failed", error);
            outputs.push(formatDshError(error));
        }
    } finally { console.error = original; }
    assert.ok(outputs.every(output => !/DUMMY_|Bearer|Authorization|prompt:|\n/.test(output)));
    assert.equal(errorCategory(new Error("429")), "rate_limit");
});
