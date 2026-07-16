import "dotenv/config";
import { Telegraf } from "telegraf";
import OpenAI from "openai";

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.OPENAI_API_KEY;
const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const bot = new Telegraf(token);
const openai = new OpenAI({ apiKey });

const HELP_TEXT = [
  "Send me a description and I'll generate an image.",
  "",
  "Commands:",
  "/start — welcome message",
  "/help — show this help",
  "/imagine <prompt> — generate from a prompt",
  "",
  "Or just send any text message as your prompt.",
].join("\n");

bot.start((ctx) =>
  ctx.reply(
    "Hi! I'm an image generation bot.\n\nDescribe what you want to see, or use /imagine <prompt>."
  )
);

bot.help((ctx) => ctx.reply(HELP_TEXT));

bot.command("imagine", async (ctx) => {
  const prompt = ctx.message.text.replace(/^\/imagine(@\w+)?\s*/i, "").trim();
  if (!prompt) {
    await ctx.reply("Usage: /imagine a cat astronaut floating in space");
    return;
  }
  await generateAndSend(ctx, prompt);
});

bot.on("text", async (ctx) => {
  const prompt = ctx.message.text.trim();
  if (!prompt || prompt.startsWith("/")) return;
  await generateAndSend(ctx, prompt);
});

async function generateAndSend(ctx, prompt) {
  const status = await ctx.reply("Generating image… this can take a few seconds.");

  try {
    const image = await createImage(prompt);
    await ctx.replyWithPhoto(
      { source: image },
      { caption: prompt.length > 900 ? `${prompt.slice(0, 897)}…` : prompt }
    );
  } catch (err) {
    console.error("Image generation failed:", err);
    const message =
      err?.error?.message ||
      err?.message ||
      "Something went wrong while generating the image.";
    await ctx.reply(`Couldn't generate that image.\n\n${message}`);
  } finally {
    try {
      await ctx.deleteMessage(status.message_id);
    } catch {
      // ignore if status message was already gone
    }
  }
}

async function createImage(prompt) {
  const response = await openai.images.generate({
    model: imageModel,
    prompt,
    n: 1,
    size: imageModel === "dall-e-2" ? "1024x1024" : "1024x1024",
    ...(imageModel.startsWith("dall-e")
      ? { response_format: "b64_json" }
      : {}),
  });

  const item = response.data?.[0];
  if (!item) {
    throw new Error("No image returned from the API.");
  }

  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  }

  if (item.url) {
    const res = await fetch(item.url);
    if (!res.ok) {
      throw new Error(`Failed to download image (${res.status}).`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  throw new Error("Image response had neither b64_json nor url.");
}

bot.catch((err, ctx) => {
  console.error(`Bot error for update ${ctx.updateType}:`, err);
});

bot.launch().then(() => {
  console.log(`Bot is running (model: ${imageModel}). Press Ctrl+C to stop.`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
