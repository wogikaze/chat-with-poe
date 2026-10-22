// Never log or return upstream messages: they may contain credentials or prompts.
export function errorCategory(error) {
    const detail = String(error?.message || "");
    if (/MISSING_CREDENTIAL|401|403|unauthorized|permission.?denied/i.test(detail)) return "authentication";
    if (/429|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(detail)) return "rate_limit";
    if (/timeout|timed out|ETIMEDOUT/i.test(detail)) return "timeout";
    if (/TransportClosed|transport.*closed|JSON-RPC input closed|process.*exited/i.test(detail)) return "transport_closed";
    return "upstream_failure";
}

export function logError(event, error) {
    // Event labels are constants supplied by the application, never upstream data.
    const label = /^[a-z_]+$/.test(event) ? event : "operation_failed";
    console.error(JSON.stringify({ event: label, category: errorCategory(error) }));
}

export function formatDshError(error) {
    switch (errorCategory(error)) {
        case "authentication": return "Gemini (Vertex AI) の認証に失敗しました。管理者に設定の確認を依頼してください。";
        case "rate_limit": return "Gemini (Vertex AI) の利用上限に達したか、一時的に混雑しています。少し待って再試行してください。";
        case "timeout": return "DSH の応答がタイムアウトしました。少し待って再試行してください。";
        default: return "DSH / Gemini でエラーが発生しました。少し待って再試行してください。";
    }
}
