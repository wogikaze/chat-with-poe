import { GoogleAuth } from "google-auth-library";

// Open-model MaaS uses the OpenAI-compatible Vertex endpoint, not Gemini's
// generateContent route. Keep it independent of the DSH agent subprocess.
export function createVertexChatClient({ projectId, location = "global", auth, fetchImpl = fetch } = {}) {
    if (!/^[a-z0-9-]+$/.test(location)) throw new Error("Invalid IM Vertex location");
    const credentials = auth || new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"], projectId });
    let clientPromise;
    const getClient = () => {
        if (!clientPromise) {
            clientPromise = credentials.getClient().catch(() => {
                clientPromise = null;
                throw new Error("MISSING_CREDENTIAL: IM Vertex authentication failed");
            });
        }
        return clientPromise;
    };

    return async function complete({ model, messages, maxTokens, signal }) {
        signal?.throwIfAborted();
        const project = projectId || await credentials.getProjectId();
        if (typeof project !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(project)) {
            throw new Error("MISSING_CREDENTIAL: IM Vertex project is not configured");
        }
        const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
        const modelId = model.replace(/^google\//, "");
        const gemini = modelId.startsWith("gemini-");
        const base = `https://${host}/v1/projects/${project}/locations/${location}`;
        const url = gemini
            ? `${base}/publishers/google/models/${encodeURIComponent(modelId)}:generateContent`
            : `${base}/endpoints/openapi/chat/completions`;
        const body = gemini ? {
            systemInstruction: { parts: messages.filter(row => row.role === "system").map(row => ({ text: row.content })) },
            contents: messages.filter(row => row.role !== "system").map(row => ({
                role: row.role === "assistant" ? "model" : "user", parts: [{ text: row.content }],
            })),
            generationConfig: { temperature: 0, maxOutputTokens: maxTokens,
                thinkingConfig: modelId.startsWith("gemini-2") ? { thinkingBudget: 0, includeThoughts: false }
                    : { thinkingLevel: "MINIMAL", includeThoughts: false } },
        } : { model, messages, max_tokens: maxTokens, temperature: 0,
            stream: false, chat_template_kwargs: { enable_thinking: false } };
        const client = await getClient();
        signal?.throwIfAborted();
        const headers = new Headers(await client.getRequestHeaders(url));
        signal?.throwIfAborted();
        headers.set("content-type", "application/json");
        const response = await fetchImpl(url, {
            method: "POST", headers, redirect: "error", signal,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            // Response bodies and auth headers can contain sensitive diagnostics.
            await response.body?.cancel().catch(() => {});
            throw Object.assign(new Error(`IM Vertex API failed (${response.status})`), { status: response.status });
        }
        const data = await response.json();
        if (data.choices?.[0]?.finish_reason === "length" || data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
            const error = new Error("IM output limit exceeded");
            error.code = "IM_TRUNCATED";
            throw error;
        }
        const text = gemini ? data.candidates?.[0]?.content?.parts?.filter(part => !part.thought && typeof part.text === "string")
            .map(part => part.text).join("") : data.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim()) throw new Error("IM Vertex returned no text");
        return text.trim();
    };
}
