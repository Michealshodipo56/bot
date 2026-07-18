import "dotenv/config";
import { Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const imageModel =
  process.env.OPENROUTER_IMAGE_MODEL || "google/gemini-2.5-flash-image";

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (!openRouterKey) {
  console.error("Missing OPENROUTER_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const bot = new Telegraf(token);

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
    await ctx.reply(`Couldn't change the clothes.\n\n${friendlyError(err)}`);
  } finally {
    try {
      await ctx.deleteMessage(status.message_id);
    } catch {
      // ignore if status message was already gone
    }
  }
}

function friendlyError(err) {
  const raw = String(err?.error?.message || err?.message || err || "");
  const text = raw.toLowerCase();

  if (
    text.includes("429") ||
    text.includes("resource_exhausted") ||
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("insufficient")
  ) {
    return [
      "API quota/credits limit hit.",
      "",
      "Check your OpenRouter credits:",
      "https://openrouter.ai/settings/credits",
      "",
      "Then restart the bot and try again.",
    ].join("\n");
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || raw.slice(0, 500);
  } catch {
    return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
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

  const dataUrl = `data:${input.contentType};base64,${input.buffer.toString("base64")}`;

  // Prefer dedicated Image API (image-to-image with references)
  try {
    return await editViaImagesApi(prompt, dataUrl);
  } catch (imagesErr) {
    console.warn("Images API failed, trying chat completions:", imagesErr.message);
    return await editViaChatCompletions(prompt, dataUrl);
  }
}

async function editViaImagesApi(prompt, dataUrl) {
  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/telegram-outfit-bot",
      "X-Title": "Telegram Outfit Bot",
    },
    body: JSON.stringify({
      model: imageModel,
      prompt,
      input_references: [
        {
          type: "image_url",
          image_url: { url: dataUrl },
        },
      ],
    }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      result?.error?.message ||
        result?.message ||
        JSON.stringify(result?.error || result)
    );
  }

  const item = result.data?.[0];
  if (item?.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  }
  if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) {
      throw new Error(`Failed to download image (${imgRes.status}).`);
    }
    return Buffer.from(await imgRes.arrayBuffer());
  }

  throw new Error("OpenRouter Images API returned no image.");
}

async function editViaChatCompletions(prompt, dataUrl) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/telegram-outfit-bot",
      "X-Title": "Telegram Outfit Bot",
    },
    body: JSON.stringify({
      model: imageModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      modalities: ["image", "text"],
    }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      result?.error?.message ||
        result?.message ||
        JSON.stringify(result?.error || result)
    );
  }

  const message = result.choices?.[0]?.message;
  const images = message?.images || [];

  for (const image of images) {
    const url = image?.image_url?.url || image?.imageUrl?.url;
    if (!url) continue;

    if (url.startsWith("data:")) {
      const base64 = url.split(",")[1];
      if (base64) return Buffer.from(base64, "base64");
    }

    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      throw new Error(`Failed to download image (${imgRes.status}).`);
    }
    return Buffer.from(await imgRes.arrayBuffer());
  }

  // Some providers put image parts in content
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const url = part?.image_url?.url;
      if (url?.startsWith("data:")) {
        const base64 = url.split(",")[1];
        if (base64) return Buffer.from(base64, "base64");
      }
    }
  }

  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text).filter(Boolean).join(" ")
        : "";

  throw new Error(
    text || "OpenRouter did not return an edited image. Try another photo."
  );
}

bot.catch((err, ctx) => {
  console.error(`Bot error for update ${ctx.updateType}:`, err);
});

bot.launch().then(() => {
  console.log(`Outfit bot running via OpenRouter (${imageModel}). Press Ctrl+C to stop.`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
