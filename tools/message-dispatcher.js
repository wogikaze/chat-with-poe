import { loadImContext } from "./im-context.js";
import { formatImError } from "./im-service.js";
import { logError } from "./errors.js";

export function parseImMessage(content, botId) {
    let text = content.trimStart();
    const mention = text.match(/^<@!?(\d+)>\s*/);
    if (mention?.[1] === botId) text = text.slice(mention[0].length).trimStart();
    const command = text.match(/^\/im(?:\s+|$)/i);
    return command ? text.slice(command[0].length) : null;
}

export function createMessageDispatcher({ getBotUser, isClosing, coordinator, imService, startTyping, reply }) {
    return function dispatch(message) {
        if (message.author.bot || isClosing()) return;
        const bot = getBotUser();
        if (!bot) return;
        // IM is recognized before admission to the ordinary conversation batch.
        // It must neither wait for nor revise/suppress an in-flight answer.
        const input = parseImMessage(message.content, bot.id);
        if (input !== null) {
            return (async () => {
                if (!input.trim()) {
                    await reply(message, "変換するテキストを入力してください。");
                    return;
                }
                const stopTyping = startTyping(message.channel);
                try { await reply(message, await imService.convert(input, { loadContext: signal => loadImContext(message, signal) })); }
                catch (error) {
                    logError("im_conversion_failed", error);
                    await reply(message, formatImError(error));
                } finally { stopTyping(); }
            })().catch(error => logError("im_reply_failed", error));
        }
        const key = `${message.channelId}:${message.author.id}`;
        const invited = message.mentions.has(bot);
        if (!invited && message.mentions.users.size > 0) {
            coordinator.suppress(key);
            return;
        }
        if (!coordinator.submit(key, message, { invited }) && invited) {
            return reply(message, "処理が混み合っています。少し待って再送してください。")
                .catch(error => logError("busy_reply_failed", error));
        }
    };
}
