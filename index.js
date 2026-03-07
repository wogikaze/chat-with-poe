import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
} from "discord.js";
import { OpenAI } from "openai";
import dotenv from "dotenv";
dotenv.config();

// --------------- Poe/OpenAI client ---------------
const openai = new OpenAI({
    apiKey: process.env.POE_API_KEY,
    baseURL: "https://api.poe.com/v1",
});

const MODEL = process.env.POE_MODEL || "gpt-4o-mini";

async function askPoe(messages) {
    const res = await openai.chat.completions.create({ model: MODEL, messages });
    return res.choices[0].message.content;
}

// --------------- Slash command definition ---------------
const commands = [
    new SlashCommandBuilder()
        .setName("chat")
        .setDescription("BOTに質問する")
        .addStringOption(opt =>
            opt.setName("text").setDescription("質問内容").setRequired(true)
        ),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

// --------------- Discord client ---------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("Slash commands registered globally.");
    } catch (err) {
        console.error("Failed to register slash commands:", err);
    }
});

// --------------- /chat command ---------------
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "chat") return;

    const text = interaction.options.getString("text");
    await interaction.deferReply();

    try {
        const answer = await askPoe([{ role: "user", content: text }]);
        await interaction.editReply(answer);
    } catch (err) {
        console.error(err);
        await interaction.editReply("エラーが発生しました。");
    }
});

// --------------- @mention handler ---------------
client.on("messageCreate", async message => {
    // Ignore bots (including self)
    if (message.author.bot) return;

    // Must mention this bot
    if (!message.mentions.has(client.user)) return;

    // Extract question text (strip all mentions)
    const text = message.content.replace(/<@!?\d+>/g, "").trim();

    if (!text) {
        await message.reply("質問を入力してください。");
        return;
    }

    const messages = [];

    // If this is a reply to another message, add context
    if (message.reference) {
        try {
            const ref = await message.fetchReference();
            if (ref.author.id === client.user.id) {
                // Replied to bot's own message → treat as conversation continuation
                messages.push({ role: "assistant", content: ref.content });
            } else {
                // Replied to someone else's message → add as context
                messages.push({
                    role: "user",
                    content: `[引用メッセージ (${ref.author.username})]\n${ref.content}`,
                });
            }
        } catch (err) {
            console.error("Failed to fetch referenced message:", err);
        }
    }

    messages.push({ role: "user", content: text });

    try {
        const answer = await askPoe(messages);
        await message.reply(answer);
    } catch (err) {
        console.error(err);
        await message.reply("エラーが発生しました。");
    }
});

client.login(process.env.DISCORD_TOKEN);
