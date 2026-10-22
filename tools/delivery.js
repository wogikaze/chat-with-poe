// Discord counts UTF-16 code units. Slice only between Unicode code points.
function safeCut(text, available) {
    let cut = Math.min(text.length, available);
    if (cut > 0 && cut < text.length && /[\uD800-\uDBFF]/.test(text[cut - 1]) && /[\uDC00-\uDFFF]/.test(text[cut])) cut--;
    return cut;
}

export function nextFence(line, fence) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/);
    if (!match) return fence;
    const [, marker, info] = match;
    if (fence) return marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !info.trim() ? null : fence;
    if (marker[0] === "`" && info.includes("`")) return null;
    return { marker, opening: `${marker}${info}` };
}

export function splitDiscordMessage(value, limit = 2000) {
    if (!Number.isInteger(limit) || limit < 16) throw new RangeError("Message limit must be at least 16");
    const text = String(value || "");
    if (!text) return [""];
    const chunks = [];
    let current = "";
    let fence = null;
    const suffix = active => active ? `\n${active.marker}` : "";
    const flush = () => {
        if (current) chunks.push(current + suffix(fence));
        current = fence ? `${fence.opening}\n` : "";
    };
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
        const next = nextFence(line, fence);
        // Fence delimiters must remain atomic. A delimiter with no room for
        // even one surrogate pair cannot be safely reopened within this limit.
        const delimiter = next !== fence;
        if (delimiter) {
            const overhead = next ? next.opening.length + 1 + suffix(next).length + 2 : 0;
            if (overhead > limit || line.length > limit) throw new RangeError("Code fence exceeds message limit");
            if (current.length + line.length + suffix(next).length > limit) flush();
            current += line;
            fence = next;
            continue;
        }
        let remaining = line;
        while (remaining) {
            const available = limit - current.length - suffix(fence).length;
            const cut = safeCut(remaining, available);
            if (!cut) { flush(); continue; }
            current += remaining.slice(0, cut);
            remaining = remaining.slice(cut);
            if (remaining) flush();
        }
    }
    if (current) chunks.push(current + suffix(fence));
    return chunks;
}

export async function replyToInteraction(interaction, text) {
    const chunks = splitDiscordMessage(text);
    await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
    for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, ephemeral: interaction.ephemeral === true, allowedMentions: { parse: [] } });
    }
}

export async function replyToMessage(message, text) {
    const chunks = splitDiscordMessage(text);
    await message.reply({ content: chunks[0], allowedMentions: { parse: [], repliedUser: false } });
    for (const chunk of chunks.slice(1)) {
        await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
}
