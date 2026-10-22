// Text-only context, scoped to messages preceding this invocation in its channel.
// Discord REST cannot be cancelled here; its result is discarded after the bound.
export async function loadImContext(source, signal, timeoutMs = 1000) {
    const channel = source.channel;
    const channelId = source.channelId || channel?.id;
    const before = source.id;
    const eligible = message => message?.channelId === channelId
        && /^\d+$/.test(message.id) && /^\d+$/.test(before)
        && BigInt(message.id) < BigInt(before);
    const cached = [...(channel?.messages?.cache?.values() || [])].filter(eligible);
    let timer;
    let onAbort;
    try {
        signal?.throwIfAborted();
        const fetched = channel?.messages?.fetch
            ? Promise.resolve().then(() => channel.messages.fetch({ before, limit: 8 }))
                .then(messages => [...messages.values()].filter(eligible)).catch(() => cached)
            : Promise.resolve(cached);
        const recent = await Promise.race([
            fetched,
            new Promise(resolve => { timer = setTimeout(() => resolve(cached), timeoutMs); }),
            new Promise((_, reject) => {
                onAbort = () => reject(signal.reason);
                signal?.addEventListener('abort', onAbort, { once: true });
            }),
        ]);
        signal?.throwIfAborted();
        const records = recent.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).slice(-8);
        // Include an older reply target when already cached; never read another channel.
        const replyId = source.reference?.messageId;
        const reply = replyId && channel?.messages?.cache?.get(replyId);
        const record = message => ({
            id: message.id,
            author: message.author?.username || '',
            author_id: message.author?.id || '',
            content: (message.content || '').slice(0, 2000),
            truncated: (message.content || '').length > 2000,
        });
        return {
            recent_messages: records.map(record),
            previous_message_id: records.at(-1)?.id || null,
            reply_target: reply && eligible(reply) ? record(reply) : null,
        };
    } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
}
