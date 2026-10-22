import "dotenv/config";
import { logError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const patchPath = path.join(projectRoot, "dsh", "poe.patch.yml");

let harness = null;
let startPromise = null;
let closingPromise = null;
let idleTimer = null;
let activeRuns = 0;
let harnessSessionNamespace = null;
const runtimeSessions = new Map();
const sessionQueues = new Map();

function boundedNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function expandHome(value) {
    if (value === "~") return process.env.HOME;
    if (value?.startsWith("~/")) return path.join(process.env.HOME || "", value.slice(2));
    return value;
}

function createHarness() {
    const defaultDshBin = path.join(projectRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    const dshBin = process.env.DSH_BIN || defaultDshBin;
    if (!existsSync(dshBin)) throw new Error(`DSH launcher not found at ${dshBin}; set DSH_BIN in .env.`);
    const model = process.env.DSH_MODEL || process.env.GOOGLE_GEMINI_MODEL || "gemini-4-argon";
    const profile = process.env.DSH_PROFILE || "poe";
    const dshHome = expandHome(process.env.DSH_HOME);
    const childEnv = { ...process.env, DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || "read-only" };
    if (dshHome) childEnv.DSH_HOME = dshHome;
    return new DeepSeekHarness({
        dshBin,
        profile,
        patches: [patchPath],
        ...(dshHome ? { dshHome } : {}),
        cwd: projectRoot,
        processCwd: projectRoot,
        provider: process.env.DSH_PROVIDER || "google-vertex",
        model,
        reasoningEffort: "medium",
        maxTokens: boundedNumber(process.env.DSH_MAX_TOKENS, 8192, 256, 131072),
        initializeTimeoutMs: boundedNumber(process.env.DSH_START_TIMEOUT_MS, 30_000, 1_000, 120_000),
        requestTimeoutMs: boundedNumber(process.env.DSH_TURN_TIMEOUT_MS, 120_000, 5_000, 15 * 60_000),
        env: childEnv,
    });
}

async function getHarness() {
    if (closingPromise) await closingPromise;
    if (harness) return harness;
    if (!startPromise) {
        const candidate = createHarness();
        startPromise = candidate.start().then(() => {
            harness = candidate;
            // The SDK can reuse a named session while this DSH subprocess
            // lives, but cannot reopen session IDs persisted by an older one.
            harnessSessionNamespace = randomUUID().replaceAll("-", "").slice(0, 16);
            return candidate;
        }).finally(() => {
            startPromise = null;
        });
    }
    return startPromise;
}

function openSession(instance, sessionId) {
    let session = runtimeSessions.get(sessionId);
    if (session) return session;

    // The SDK's named-session handle resumes an existing id or creates it on
    // its first prompt; it does not expose a separate resumeSession method.
    session = instance.session(sessionId);
    runtimeSessions.set(sessionId, session);
    return session;
}

function isClosedTransportError(error) {
    return /TransportClosedError|JSON-RPC input closed|transport.*closed|process.*exited/i
        .test(String(error?.message || error || ""));
}

async function discardHarness(instance) {
    if (harness !== instance) return;
    clearTimeout(idleTimer);
    harness = null;
    harnessSessionNamespace = null;
    runtimeSessions.clear();
    closingPromise = instance.close().catch(error => {
        logError("harness_cleanup_failed", error);
    }).finally(() => {
        closingPromise = null;
    });
    await closingPromise;
}

function scheduleIdleClose() {
    clearTimeout(idleTimer);
    if (activeRuns > 0 || !harness) return;
    idleTimer = setTimeout(() => {
        if (activeRuns > 0 || !harness) return;
        const closing = harness;
        harness = null;
        harnessSessionNamespace = null;
        runtimeSessions.clear();
        closingPromise = closing.close().catch(error => {
            logError("harness_shutdown_failed", error);
        }).finally(() => {
            closingPromise = null;
        });
    }, boundedNumber(process.env.DSH_IDLE_TIMEOUT_MS, 5 * 60_000, 30_000, 60 * 60_000));
    idleTimer.unref?.();
}

function queueSession(sessionId, task) {
    const previous = sessionQueues.get(sessionId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    sessionQueues.set(sessionId, current);
    return previous.catch(() => {}).then(task).finally(() => {
        release();
        if (sessionQueues.get(sessionId) === current) sessionQueues.delete(sessionId);
    });
}

export function runInDsh({ sessionId, content, ephemeral = false }) {
    const sessionKey = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
    if (!sessionKey) throw new Error("A DSH session is required.");
    clearTimeout(idleTimer);
    activeRuns++;
    return queueSession(sessionKey, async () => {
        try {
            for (let attempt = 0; ; attempt++) {
                let instance;
                try {
                    instance = await getHarness();
                    const scopedSessionId = `${harnessSessionNamespace}-${sessionKey}`;
                    const session = ephemeral ? instance.session(scopedSessionId) : openSession(instance, scopedSessionId);
                    const result = await session.run(content);
                    return result.finalResponse?.trim() || "回答を生成できませんでした。";
                } catch (error) {
                    if (attempt > 0 || !isClosedTransportError(error)) throw error;
                    logError("harness_transport_retry", error);
                    if (instance) await discardHarness(instance);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        } finally {
            activeRuns--;
            scheduleIdleClose();
        }
    });
}

export async function closeDsh() {
    clearTimeout(idleTimer);
    if (startPromise) await startPromise.catch(() => {});
    const drainUntil = Date.now() + 15_000;
    while (activeRuns > 0 && Date.now() < drainUntil) {
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!harness) {
        if (closingPromise) await closingPromise;
        return;
    }
    const closing = harness;
    harness = null;
    harnessSessionNamespace = null;
    runtimeSessions.clear();
    closingPromise = closing.close().finally(() => {
        closingPromise = null;
    });
    await closingPromise;
}

console.log(`Using DeepSeek Harness profile ${process.env.DSH_PROFILE || "poe"} (provider: ${process.env.DSH_PROVIDER || "google-vertex"}, model: ${process.env.DSH_MODEL || process.env.GOOGLE_GEMINI_MODEL || "gemini-4-argon"}).`);
