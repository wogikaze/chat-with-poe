import { errorCategory, logError } from "./errors.js";
import { buildImMessages, buildImRepairMessages, hasLatexMath } from "./im-prompt.js";

export const DEFAULT_IM_MODEL = "google/gemma-4-26b-a4b-it-maas";
export const DEFAULT_IM_FALLBACK_MODEL = "gemini-3.1-flash-lite";

function imError(code, message) {
    return Object.assign(new Error(message), { code });
}

export function createImService({ complete, model = DEFAULT_IM_MODEL, timeoutMs = 15000,
    maxConcurrent = 4, maxTokens = 2048, fallbackModel = DEFAULT_IM_FALLBACK_MODEL,
    fallbackCooldownMs = 60000, now = Date.now }) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new Error("Invalid IM concurrency");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Invalid IM timeout");
    const active = new Set();
    let closed = false;
    let fallbackUntil = 0;
    const activeModel = () => fallbackModel && fallbackModel !== model && now() < fallbackUntil ? fallbackModel : model;
    async function request(messages, signal) {
        const selected = activeModel();
        const input = { messages, maxTokens, signal };
        try { return await complete({ ...input, model: selected }); }
        catch (error) {
            if (signal.aborted || selected !== model || !fallbackModel || fallbackModel === model
                || ![403, 404, 429, 500, 502, 503, 504].includes(error?.status)) throw error;
            fallbackUntil = now() + fallbackCooldownMs;
            logError("im_primary_unavailable", error);
            signal.throwIfAborted();
            return complete({ ...input, model: fallbackModel });
        }
    }
    return {
        model,
        get activeModel() { return activeModel(); },
        async convert(text, { loadContext } = {}) {
            if (closed) throw imError("IM_CLOSED", "IM service closed");
            if (typeof text !== "string" || !text.trim()) throw imError("IM_INPUT", "IM input required");
            if (text.length > 4000) throw imError("IM_INPUT", "IM input too long");
            if (active.size >= maxConcurrent) throw imError("IM_BUSY", "IM concurrency limit reached");
            const controller = new AbortController();
            active.add(controller);
            const timer = setTimeout(() => controller.abort(imError("IM_TIMEOUT", "IM request timed out")), timeoutMs);
            let onAbort;
            try {
                return await Promise.race([
                    Promise.resolve().then(async () => {
                        controller.signal.throwIfAborted();
                        const context = loadContext ? await loadContext(controller.signal) : undefined;
                        controller.signal.throwIfAborted();
                        const messages = buildImMessages(text, context);
                        let result = await request(messages, controller.signal);
                        if (!hasLatexMath(result)) return result;
                        // Only malformed math gets one repair call. It stays on the
                        // lightweight path, in the same slot and original deadline.
                        controller.signal.throwIfAborted();
                        result = await request(buildImRepairMessages(messages, result), controller.signal);
                        if (hasLatexMath(result)) throw imError("IM_FORMAT", "IM returned unsupported math formatting");
                        return result;
                    }),
                    new Promise((_, reject) => {
                        onAbort = () => reject(controller.signal.reason);
                        controller.signal.addEventListener("abort", onAbort, { once: true });
                    }),
                ]);
            } finally {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", onAbort);
                active.delete(controller);
            }
        },
        close() {
            closed = true;
            for (const controller of active) controller.abort(imError("IM_CLOSED", "IM service closed"));
        },
    };
}

export function formatImError(error) {
    if (error?.code === "IM_BUSY") return "変換が混み合っています。少し待って再送してください。";
    if (error?.code === "IM_INPUT") return "変換するテキストを1〜4000文字で入力してください。";
    if (error?.code === "IM_FORMAT") return "数式の表記を整えられませんでした。もう一度お試しください。";
    if (error?.code === "IM_TRUNCATED") return "変換結果が長すぎます。入力を分けて再送してください。";
    if (error?.code === "IM_TIMEOUT" || errorCategory(error) === "timeout") return "変換がタイムアウトしました。もう一度お試しください。";
    if (errorCategory(error) === "authentication") return "IMEモデルの認証・アクセス権を確認してください。";
    if (errorCategory(error) === "rate_limit") return "IMEモデルが混み合っています。少し待って再送してください。";
    return "変換できませんでした。少し待って再送してください。";
}
