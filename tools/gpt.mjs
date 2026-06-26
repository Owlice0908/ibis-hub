#!/usr/bin/env node
/**
 * gpt — a tiny bridge so Claude (or you) can call OpenAI from inside an
 * Ibis Hub session: text help from GPT, and image generation.
 *
 * Usage:
 *   gpt ask   "your question"            → prints GPT's answer
 *   gpt image "a red fox, flat icon"     → generates an image, saves to ~/Downloads
 *
 * Options for `image`:
 *   --size 1024x1024 | 1024x1536 | 1536x1024   (default 1024x1024)
 *   --quality low | medium | high              (default medium — cheaper)
 *   --out /path/to/file.png                    (default ~/Downloads/gpt-image-<time>.png)
 *
 * API key (used-amount billing, separate from ChatGPT Plus) is read from:
 *   1. env  OPENAI_API_KEY
 *   2. file ~/.ibis-hub/openai.key   (just paste the key into this file)
 *
 * Model overrides via env: OPENAI_MODEL (chat, default "gpt-4o").
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function loadKey() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) {
    return process.env.OPENAI_API_KEY.trim();
  }
  try {
    const k = readFileSync(join(homedir(), ".ibis-hub", "openai.key"), "utf-8").trim();
    if (k) return k;
  } catch {}
  return null;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const key = loadKey();
if (!key) {
  die(
    "OpenAI APIキーが見つかりません。\n" +
    "  ~/.ibis-hub/openai.key にキーを貼り付けるか、環境変数 OPENAI_API_KEY を設定してください。"
  );
}

const [, , cmd, ...rest] = process.argv;

// Pull out --flags, leave the rest as the prompt
const flags = {};
const promptParts = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--")) {
    flags[a.slice(2)] = rest[i + 1];
    i++;
  } else {
    promptParts.push(a);
  }
}
const prompt = promptParts.join(" ").trim();

async function ask() {
  if (!prompt) die('使い方: gpt ask "聞きたいこと"');
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) die(`OpenAI APIエラー (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  process.stdout.write(text + "\n");
}

async function image() {
  if (!prompt) die('使い方: gpt image "作りたい画像の説明"');
  const size = flags.size || "1024x1024";
  const quality = flags.quality || "medium";
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size, quality, n: 1 }),
  });
  if (!res.ok) die(`OpenAI 画像APIエラー (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) die("画像データが返ってきませんでした。");

  const downloads = join(homedir(), "Downloads");
  try { mkdirSync(downloads, { recursive: true }); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = flags.out || join(downloads, `gpt-image-${stamp}.png`);
  writeFileSync(out, Buffer.from(b64, "base64"));
  // Print the path on its own line so callers (and Claude) can grab it easily
  console.log(out);
}

(async () => {
  try {
    if (cmd === "ask") await ask();
    else if (cmd === "image") await image();
    else {
      die(
        "使い方:\n" +
        '  gpt ask   "聞きたいこと"\n' +
        '  gpt image "作りたい画像の説明"  [--size 1024x1024] [--quality low|medium|high] [--out file.png]'
      );
    }
  } catch (e) {
    die(`実行エラー: ${e?.message || e}`);
  }
})();
