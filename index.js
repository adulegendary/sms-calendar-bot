import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Store conversation history per phone number (in-memory; use Redis/DB for production)
const conversations = {};

const SYSTEM_PROMPT = `You are a personal calendar assistant that communicates via SMS. 
You help the user manage their Google Calendar — checking schedules, creating events, setting reminders, and finding free time.

Rules:
- Keep replies SHORT and SMS-friendly (under 300 characters when possible)
- Use plain text, no markdown
- When listing events, use a compact format: "9am Team standup, 2pm Dentist"
- Always confirm actions before making changes (unless the user says "just do it")
- If asked for reminders, create a calendar event with a reminder notification
- Be conversational and friendly
- Today's date context: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;

async function askClaude(phoneNumber, userMessage) {
  // Initialize conversation history for new users
  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = [];
  }

  // Add user message to history
  conversations[phoneNumber].push({
    role: "user",
    content: userMessage,
  });

  // Keep last 10 messages to stay within context limits
  const recentHistory = conversations[phoneNumber].slice(-10);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: recentHistory,
    });

    // Extract text from response
    const assistantMessage = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Add assistant response to history
    conversations[phoneNumber].push({
      role: "assistant",
      content: assistantMessage,
    });

    console.log(`Claude reply: ${assistantMessage}`);
    return assistantMessage;
  } catch (error) {
    console.error("Claude API error:", error);
    return "Sorry, I had trouble processing that. Please try again.";
  }
}

// Webhook endpoint Twilio calls when you receive an SMS
app.post("/sms", async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const fromNumber = req.body.From;

  console.log(`SMS from ${fromNumber}: ${incomingMsg}`);

  if (!incomingMsg || !fromNumber) {
    return res.status(400).send("Bad request");
  }

  // Handle "reset" command to clear conversation history
  if (incomingMsg.toLowerCase() === "reset") {
    conversations[fromNumber] = [];
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Conversation reset. How can I help you?");
    res.type("text/xml").send(twiml.toString());
    return;
  }

  // Get Claude's reply
  const reply = await askClaude(fromNumber, incomingMsg);

  // Send reply via Twilio
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.type("text/xml").send(twiml.toString());
});

// Health check
app.get("/", (req, res) => {
  res.send("SMS Calendar Bot is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/sms`);
});
