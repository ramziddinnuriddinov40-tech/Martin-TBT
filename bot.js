import http from "node:http";
import { GoogleGenAI } from "@google/genai";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Модель можно сменить в Render без правки кода (переменная GEMINI_MODEL)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Запасная модель на случай перегрузки основной (необязательно)
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "";
// Пример: ALLOWED_CHAT_IDS=123456789,987654321
const ALLOWED = new Set(
  (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
  console.error("Нужны переменные TELEGRAM_BOT_TOKEN и GEMINI_API_KEY");
  process.exit(1);
}
if (ALLOWED.size === 0) {
  console.warn("ВНИМАНИЕ: ALLOWED_CHAT_IDS пуст — бот отвечает всем!");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const SYSTEM_PROMPT = `Extract driver details from the attached CDL/Medical Card image(s) and user notes.
If the notes mention "team" or include 2 drivers, use the #team template. Otherwise, use the #solo template.
Output ONLY the filled template with no extra commentary or bolding (**). Leave unknown fields blank after the colon. Default Rate to $0.95/mile and Escrow to $2,500 (10 weeks) unless stated otherwise.

--- SOLO TEMPLATE ---
Recruiter: #Martin
#solo


Drivers name: 
Contact: 
Email: 

Experience: 
Rate: 
Work days: 
Home days: 
Zip code: 
Ready: 
English level: 
Work Authorization: 
Escrow: 
Application status: 
Nationality: 

Notes: 

--- TEAM TEMPLATE ---
Recruiter: #Martin
#team


Drivers name: 
Contact: 
Email: 


Drivers name: 
Contact: 
Email: 


Experience: 
Rate: 
Work days: 
Home days: 
Zip code: 
Ready: 
English level: 
Work Authorization: 
Escrow: 
Application status: 
Nationality: 

Notes: `;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Telegram helpers ----------

async function tg(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || "unknown error"}`);
  }
  return data.result;
}

async function send(chatId, text) {
  // Лимит Telegram — 4096 символов
  for (let i = 0; i < text.length; i += 4000) {
    await tg("sendMessage", { chat_id: chatId, text: text.slice(i, i + 4000) });
  }
}

async function downloadTelegramFile(fileId, fallbackMime) {
  const meta = await tg("getFile", { file_id: fileId });
  const filePath = meta.file_path;
  const res = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`
  );
  if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const lower = filePath.toLowerCase();
  let mimeType = fallbackMime || "image/jpeg";
  if (lower.endsWith(".png")) mimeType = "image/png";
  else if (lower.endsWith(".webp")) mimeType = "image/webp";
  else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mimeType = "image/jpeg";

  return { base64: buffer.toString("base64"), mimeType };
}

// ---------- Gemini ----------

async function askGemini(parts) {
  // Основная модель + необязательная запасная (GEMINI_FALLBACK_MODEL)
  const models = [GEMINI_MODEL];
  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
    models.push(GEMINI_FALLBACK_MODEL);
  }

  let lastErr;
  for (const model of models) {
    // 6 попыток, пауза растёт: 2, 4, 8, 16, 30 сек
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: { systemInstruction: SYSTEM_PROMPT },
        });
        const text = (response.text || "")
          .replace(/^```[a-z]*\n?/i, "")
          .replace(/```\s*$/, "")
          .replace(/\*\*/g, "")
          .trim();
        if (text) return text;
        lastErr = new Error("Gemini вернул пустой ответ");
      } catch (err) {
        lastErr = err;
        const msg = String(err.message || err);
        // Временные ошибки (перегрузка, лимит) — повторяем.
        // Остальные (404, 400, 403) — смысла повторять нет.
        const temporary = /503|429|500|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|fetch failed/i.test(msg);
        if (!temporary) break;
      }
      if (attempt < 6) {
        console.warn(`Gemini (${model}) попытка ${attempt} не удалась, жду...`);
        await sleep(Math.min(2000 * 2 ** (attempt - 1), 30000));
      }
    }
  }
  throw lastErr;
}

// ---------- Обработка сообщений ----------

async function processMessages(chatId, msgs) {
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

    const notes = msgs
      .map((m) => m.caption || m.text || "")
      .filter(Boolean)
      .join("\n");

    const parts = [];
    if (notes) parts.push({ text: notes });

    for (const m of msgs) {
      if (Array.isArray(m.photo) && m.photo.length > 0) {
        const largest = m.photo[m.photo.length - 1];
        const { base64, mimeType } = await downloadTelegramFile(largest.file_id);
        parts.push({ inlineData: { data: base64, mimeType } });
      } else if (m.document && (m.document.mime_type || "").startsWith("image/")) {
        const { base64, mimeType } = await downloadTelegramFile(
          m.document.file_id,
          m.document.mime_type
        );
        parts.push({ inlineData: { data: base64, mimeType } });
      }
    }

    if (parts.length === 0) return;

    const text = await askGemini(parts);
    await send(chatId, text);
  } catch (err) {
    console.error("Ошибка обработки:", err);
    await send(chatId, "Ошибка обработки: " + err.message).catch(() => {});
  }
}

// Альбомы: собираем сообщения с одним media_group_id в один запрос
const albums = new Map();

function handleMessage(msg) {
  const chatId = msg.chat.id;

  if (ALLOWED.size > 0 && !ALLOWED.has(chatId)) {
    console.warn("Чужой chat_id:", chatId);
    return;
  }
  if (msg.text && msg.text.startsWith("/start")) {
    send(chatId, "Отправь фото CDL / medical card и заметки в подписи.").catch(() => {});
    return;
  }

  const groupId = msg.media_group_id;
  if (!groupId) {
    processMessages(chatId, [msg]);
    return;
  }

  let album = albums.get(groupId);
  if (!album) {
    album = { chatId, msgs: [], timer: null };
    albums.set(groupId, album);
  }
  album.msgs.push(msg);
  clearTimeout(album.timer);
  album.timer = setTimeout(() => {
    albums.delete(groupId);
    processMessages(album.chatId, album.msgs);
  }, 2000);
}

// ---------- Polling ----------

async function pollUpdates() {
  // Если ранее стоял webhook, getUpdates не работает
  await tg("deleteWebhook", { drop_pending_updates: false }).catch((e) =>
    console.error(e.message)
  );

  let offset = 0;
  console.log("Бот запущен");

  while (true) {
    try {
      const res = await fetch(
        `${API}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${encodeURIComponent(
          JSON.stringify(["message"])
        )}`
      );
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.description || "getUpdates failed");
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          try {
            handleMessage(update.message);
          } catch (err) {
            console.error("handleMessage:", err);
          }
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await sleep(3000);
    }
  }
}

// Мини-сервер для Render (Web Service должен слушать порт).
// UptimeRobot будет пинговать этот адрес, чтобы бот не засыпал.
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running");
  })
  .listen(PORT, () => console.log("HTTP server on port " + PORT));

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

pollUpdates();
