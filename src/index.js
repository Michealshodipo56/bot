import "dotenv/config";
import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.GEMINI_API_KEY;
const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (!apiKey) {
  console.error("Missing GEMINI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const bot = new Telegraf(token);
const ai = new GoogleGenAI({ apiKey });

const INSTRUCTIONS = [
  "Send me a photo of someone and I'll change their clothes to a different outfit.",
  "",
  "How to use:",
  "1. Send a clear photo of a person",
  "2. Wait a few seconds",
  "3. I'll reply with the same person in new clothes",
  "",
  "Optional: add a caption to describe the outfit you want.",
  "Example caption: red leather jacket and black jeans",
].join("\n");

const OUTFIT_IDEAS = [
  "a casual streetwear look with a hoodie and sneakers",
  "a sharp formal suit and dress shoes",
  "a colorful summer outfit with a light shirt and shorts",
  "a stylish denim jacket over a plain tee",
  "an elegant evening dress or tailored evening wear",
  "a cozy knit sweater and chinos",
  "a sporty athletic tracksuit",
  "a vintage 90s inspired outfit",
  "a smart-casual blazer with dark jeans",
  "a light raincoat and boots",
];

bot.start((ctx) => ctx.reply(INSTRUCTIONS));
bot.help((ctx) => ctx.reply(INSTRUCTIONS));

bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  await ctx.reply(INSTRUCTIONS);
});

bot.on("photo", async (ctx) => {
  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  const caption = ctx.message.caption?.trim() || "";
  await changeClothesAndSend(ctx, largest.file_id, caption);
});

bot.on("document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith("image/")) {
    await ctx.reply(INSTRUCTIONS);
    return;
  }
  const caption = ctx.message.caption?.trim() || "";
  await changeClothesAndSend(ctx, doc.file_id, caption);
});

async function changeClothesAndSend(ctx, fileId, caption) {
  const status = await ctx.reply("Changing the outfit… this can take a few seconds.");

  try {
    const input = await downloadTelegramFile(ctx, fileId);
    const outfit =
      caption || OUTFIT_IDEAS[Math.floor(Math.random() * OUTFIT_IDEAS.length)];
    const result = await editClothes(input, outfit);

    await ctx.replyWithPhoto(
      { source: result },
      { caption: caption ? `Outfit: ${caption}` : "Here's a new outfit." }
    );
  } catch (err) {
    console.error("Outfit change failed:", err);
    const message =
      err?.error?.message ||
      err?.message ||
      "Something went wrong while editing the image.";
    await ctx.reply(`Couldn't change the clothes.\n\n${message}`);
  } finally {
    try {
      await ctx.deleteMessage(status.message_id);
    } catch {
      // ignore if status message was already gone
    }
  }
}

async function downloadTelegramFile(ctx, fileId) {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.href);
  if (!res.ok) {
    throw new Error(`Failed to download photo from Telegram (${res.status}).`);
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());

  return { buffer, contentType };
}

async function editClothes(input, outfit) {
  const prompt = [
    "Edit this photo: change only the person's clothing to a completely different outfit.",
    `New outfit: ${outfit}.`,
    "Keep the same person, face, body, pose, background, lighting, and framing.",
    "Do not change identity, age, or appearance — only the clothes.",
  ].join(" ");

  const response = await ai.models.generateContent({
    model: imageModel,
    contents: [
      {
        inlineData: {
          mimeType: input.contentType,
          data: input.buffer.toString("base64"),
        },
      },
      { text: prompt },
    ],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, "base64");
    }
  }

  const text = parts
    .map((part) => part.text)
    .filter(Boolean)
    .join(" ")
    .trim();

  throw new Error(
    text || "Gemini did not return an edited image. Try another photo."
  );
}

bot.catch((err, ctx) => {
  console.error(`Bot error for update ${ctx.updateType}:`, err);
});

bot.launch().then(() => {
  console.log(`Outfit bot running (model: ${imageModel}). Press Ctrl+C to stop.`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
