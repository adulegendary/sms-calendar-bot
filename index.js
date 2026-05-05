import express from "express";
import TelegramBot from "node-telegram-bot-api";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const conversations = {};

// Persist known chat IDs so reminders survive restarts
const USERS_FILE = "users.json";
const knownChatIds = new Set(existsSync(USERS_FILE) ? JSON.parse(readFileSync(USERS_FILE)) : []);
const sentReminders = new Set(); // tracks eventId+minute to avoid duplicate alerts

function saveUsers() {
  writeFileSync(USERS_FILE, JSON.stringify([...knownChatIds]));
}

function getCalendarClient() {
  const credentials = JSON.parse(readFileSync("credentials.json"));
  const { client_id, client_secret } = credentials.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, "http://localhost:3000/auth/callback");
  oauth2Client.setCredentials(JSON.parse(readFileSync("token.json")));
  return google.calendar({ version: "v3", auth: oauth2Client });
}

async function getEvents(days = 7) {
  const calendar = getCalendarClient();
  const now = new Date();
  const end = new Date();
  end.setDate(end.getDate() + days);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  const events = res.data.items;
  if (!events || events.length === 0) return "No upcoming events found.";
  return events.map((e) => {
    const start = e.start.dateTime || e.start.date;
    const date = new Date(start).toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    return `${date}: ${e.summary}`;
  }).join("\n");
}

async function createEvent(summary, startDateTime, endDateTime, description = "") {
  const calendar = getCalendarClient();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await calendar.events.insert({
    calendarId: "primary",
    resource: {
      summary,
      description,
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
    },
  });
  return `Event created: "${res.data.summary}" on ${new Date(res.data.start.dateTime).toLocaleString()}`;
}

async function deleteEvent(eventSummaryOrId) {
  const calendar = getCalendarClient();
  const now = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 30);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
    q: eventSummaryOrId,
  });

  const event = res.data.items?.[0];
  if (!event) return `No event found matching "${eventSummaryOrId}"`;
  await calendar.events.delete({ calendarId: "primary", eventId: event.id });
  return `Deleted: "${event.summary}"`;
}

// Tools Claude can call
const tools = [
  {
    name: "get_calendar_events",
    description: "Fetch the user's upcoming Google Calendar events",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead to look (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "create_calendar_event",
    description: "Create a new event in the user's Google Calendar",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        startDateTime: { type: "string", description: "Start time ISO 8601 e.g. 2026-05-06T10:00:00" },
        endDateTime: { type: "string", description: "End time ISO 8601 e.g. 2026-05-06T11:00:00" },
        description: { type: "string", description: "Optional event description" },
      },
      required: ["summary", "startDateTime", "endDateTime"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Delete an event from the user's Google Calendar by searching its name",
    input_schema: {
      type: "object",
      properties: {
        eventSummary: { type: "string", description: "The name/title of the event to delete" },
      },
      required: ["eventSummary"],
    },
  },
];

async function runTool(name, input) {
  if (name === "get_calendar_events") return await getEvents(input.days || 7);
  if (name === "create_calendar_event") return await createEvent(input.summary, input.startDateTime, input.endDateTime, input.description);
  if (name === "delete_calendar_event") return await deleteEvent(input.eventSummary);
  return "Unknown tool";
}

const SYSTEM_PROMPT = `You are a personal calendar assistant on Telegram.
You help the user manage their Google Calendar — checking schedules, creating events, deleting events, and finding free time.

Commands the user can send:
/today - show today's events
/week - show this week's events
/tomorrow - show tomorrow's events
/reset - clear conversation history
/help - list commands

Rules:
- Keep replies concise and friendly, plain text no markdown
- Always use get_calendar_events before answering questions about the user's schedule
- When creating or deleting events, confirm details first unless user says "just do it"
- Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;

async function askClaude(chatId, userMessage) {
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: "user", content: userMessage });
  const messages = [...conversations[chatId].slice(-10)];

  try {
    while (true) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") {
        const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        conversations[chatId].push({ role: "assistant", content: text });
        console.log(`Claude reply: ${text}`);
        return text;
      }

      if (response.stop_reason === "tool_use") {
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          console.log(`Tool call: ${block.name}`, block.input);
          let result;
          try { result = await runTool(block.name, block.input); }
          catch (err) { result = `Error: ${err.message}`; }
          console.log(`Tool result: ${result}`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
        messages.push({ role: "user", content: toolResults });
      }
    }
  } catch (error) {
    console.error("Claude API error:", error.message);
    return "Sorry, I had trouble processing that. Please try again.";
  }
}

// Check every minute for events starting in ~10 minutes and send reminders
async function checkReminders() {
  if (knownChatIds.size === 0) return;
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const soon = new Date(now.getTime() + 11 * 60 * 1000);
    const justBefore = new Date(now.getTime() + 9 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: justBefore.toISOString(),
      timeMax: soon.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    for (const event of res.data.items || []) {
      const key = `${event.id}-${Math.floor(now.getTime() / 60000)}`;
      if (sentReminders.has(key)) continue;
      sentReminders.add(key);

      const startTime = new Date(event.start.dateTime || event.start.date).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit",
      });

      for (const chatId of knownChatIds) {
        await bot.sendMessage(chatId, `Hi! "${event.summary}" is coming up at ${startTime} — in about 10 minutes.`);
      }
      console.log(`Reminder sent: ${event.summary}`);
    }
  } catch (err) {
    console.error("Reminder check error:", err.message);
  }
}

app.post(`/telegram/${process.env.TELEGRAM_BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const message = req.body.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  console.log(`Telegram from ${chatId}: ${text}`);

  // Track this user for reminders
  if (!knownChatIds.has(chatId)) {
    knownChatIds.add(chatId);
    saveUsers();
  }

  if (text === "/reset") {
    conversations[chatId] = [];
    await bot.sendMessage(chatId, "Conversation reset. How can I help you?");
    return;
  }

  if (text === "/help") {
    await bot.sendMessage(chatId,
      "Commands:\n/today - today's events\n/tomorrow - tomorrow's events\n/week - this week\n/reset - clear chat history\n\nOr just chat naturally:\n- \"What do I have today?\"\n- \"Schedule a meeting tomorrow at 3pm\"\n- \"Delete my dentist appointment\"\n- \"When am I free this week?\""
    );
    return;
  }

  if (text === "/today") {
    const events = await getEvents(1);
    await bot.sendMessage(chatId, `Today:\n${events}`);
    return;
  }

  if (text === "/tomorrow") {
    const calendar = getCalendarClient();
    const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setHours(23, 59, 59);
    const res = await calendar.events.list({ calendarId: "primary", timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: "startTime" });
    const items = res.data.items;
    const reply = items?.length ? items.map((e) => `${new Date(e.start.dateTime || e.start.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}: ${e.summary}`).join("\n") : "Nothing scheduled tomorrow.";
    await bot.sendMessage(chatId, `Tomorrow:\n${reply}`);
    return;
  }

  if (text === "/week") {
    const events = await getEvents(7);
    await bot.sendMessage(chatId, `This week:\n${events}`);
    return;
  }

  const reply = await askClaude(chatId, text);
  await bot.sendMessage(chatId, reply);
});

app.get("/", (_, res) => res.send("Telegram Calendar Bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  const webhookUrl = `${process.env.PUBLIC_URL}/telegram/${process.env.TELEGRAM_BOT_TOKEN}`;
  await bot.setWebHook(webhookUrl);
  console.log(`Telegram webhook set to: ${webhookUrl}`);
  setInterval(checkReminders, 60 * 1000);
  console.log("Reminder checker started (every 60s)");
});
