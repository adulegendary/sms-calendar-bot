import { google } from "googleapis";
import { readFileSync, writeFileSync } from "fs";
import http from "http";
import { URL } from "url";

const credentials = JSON.parse(readFileSync("credentials.json"));
const { client_id, client_secret, redirect_uris } = credentials.installed;

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, "http://localhost:3000/auth/callback");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

const authUrl = oauth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for authorization...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3000");
  if (url.pathname !== "/auth/callback") return;

  const code = url.searchParams.get("code");
  res.end("Authorization successful! You can close this tab and return to the terminal.");

  const { tokens } = await oauth2Client.getToken(code);
  writeFileSync("token.json", JSON.stringify(tokens, null, 2));
  console.log("token.json saved! You can now start your bot with: npm start");
  server.close();
});

server.listen(3000);
