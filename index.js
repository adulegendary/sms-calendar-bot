import express from "express";
import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// Store conversation history per chat ID (in-memory; use Redis/DB for production)
const conversations = {};

const SYSTEM_PROMPT = `You are a personal calendar assistant on Telegram.
You help the user manage their Google Calendar — checking schedules, creating events, setting reminders, and finding free time.

Rules:
- Keep replies concise and friendly
- Use plain text, no markdown
- When listing events, use a compact format: "9am Team standup, 2pm Dentist"
- Always confirm actions before making changes (unless the user says "just do it")
- Today's date context: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;

async function askClaude(chatId, userMessage) {
  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  conversations[chatId].push({ role: "user", content: userMessage });

  const recentHistory = conversations[chatId].slice(-10);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: recentHistory,
    });

    const assistantMessage = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    conversations[chatId].push({ role: "assistant", content: assistantMessage });

    console.log(`Claude reply: ${assistantMessage}`);
    return assistantMessage;
  } catch (error) {
    console.error("Claude API error:", error);
    return "Sorry, I had trouble processing that. Please try again.";
  }
}

// Telegram webhook endpoint
app.post(`/telegram/${process.env.TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  const message = update.message;

  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  console.log(`Telegram from ${chatId}: ${text}`);

  if (text.toLowerCase() === "/reset") {
    conversations[chatId] = [];
    await bot.sendMessage(chatId, "Conversation reset. How can I help you?");
    return;
  }

  const reply = await askClaude(chatId, text);
  await bot.sendMessage(chatId, reply);
});

// Health check
app.get("/", (req, res) => {
  res.send("Telegram Calendar Bot is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  const webhookUrl = `${process.env.PUBLIC_URL}/telegram/${process.env.TELEGRAM_BOT_TOKEN}`;
  await bot.setWebHook(webhookUrl);
  console.log(`Telegram webhook set to: ${webhookUrl}`);
});
