# SMS Calendar Bot

Text your own phone number to manage your Google Calendar with AI.

---

## What it does

Text the bot things like:
- "What's on my schedule tomorrow?"
- "Book dentist appointment Friday 3pm"
- "Remind me about team meeting 15 min before"
- "What's my next free hour this week?"
- "Move my 2pm to 4pm today"

---

## Setup (takes ~20 minutes)

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Get a Twilio phone number

1. Sign up at [twilio.com](https://twilio.com) (free trial gives you ~$15 credit)
2. Go to **Phone Numbers → Manage → Buy a number**
3. Pick any US number with SMS capability
4. Copy your **Account SID** and **Auth Token** from the Twilio Console dashboard

### Step 3 — Get your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key under **API Keys**

### Step 4 — Connect Google Calendar

The bot uses the Google Calendar MCP server. You need to authorize it:

1. Go to [claude.ai/settings](https://claude.ai/settings) → Connections
2. Connect Google Calendar
3. The MCP server at `https://calendarmcp.googleapis.com/mcp/v1` handles auth automatically

### Step 5 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your real values:
```
TWILIO_ACCOUNT_SID=ACxxxxxxxx...
TWILIO_AUTH_TOKEN=your_token
ANTHROPIC_API_KEY=sk-ant-...
```

### Step 6 — Run the server

```bash
npm start
```

You should see: `Server running on port 3000`

### Step 7 — Expose your server with ngrok (for local dev)

Twilio needs a public URL to send messages to your local machine.

```bash
# Install ngrok from ngrok.com, then:
ngrok http 3000
```

Copy the `https://xxxx.ngrok.io` URL it gives you.

### Step 8 — Configure Twilio webhook

1. In Twilio Console → Phone Numbers → Your number
2. Under **Messaging** → **A message comes in**
3. Set webhook URL to: `https://xxxx.ngrok.io/sms`
4. Method: **HTTP POST**
5. Save

### Step 9 — Text your bot!

Text your Twilio number from your personal phone. Try:
```
"What do I have today?"
```

---

## Deploying to production

For 24/7 availability, deploy to a cloud server instead of running locally:

| Platform | Cost | How |
|----------|------|-----|
| Railway | ~$5/mo | `railway up` |
| Render | Free tier | Connect GitHub repo |
| Fly.io | Free tier | `flyctl deploy` |

Once deployed, update the Twilio webhook URL to your production URL.

---

## Commands

| Text | What happens |
|------|-------------|
| `reset` | Clears conversation memory |
| Any natural language | Claude figures it out |

---

## Architecture

```
Your phone
   ↓ SMS
Twilio (your bot number)
   ↓ webhook POST
Express server (index.js)
   ↓ API call
Claude (claude-sonnet-4)
   ↓ MCP tool calls
Google Calendar
   ↑ event data
Claude builds reply
   ↑ TwiML response
Twilio sends SMS
   ↑
Your phone
```
