import { Client } from "@notionhq/client";
import dotenv from "dotenv";
dotenv.config();

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
notion.search({ page_size: 20 }).then((res) => {
  res.results.forEach((p) => {
    const title = p.object === "database"
      ? p.title?.[0]?.plain_text
      : p.properties?.title?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.plain_text || "(untitled)";
    console.log(`[${p.object}] ${title} — ${p.id}`);
  });
});
