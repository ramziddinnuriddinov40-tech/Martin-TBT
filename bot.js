import http from "node:http";
import { GoogleGenAI } from "@google/genai";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Запасная модель на случай перегрузки основной (необязательно)
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "";
// Необязательно. Пример: ALLOWED_CHAT_IDS=123456789,987654321
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

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const SYSTEM_PROMPT = `You receive a transcript of a phone/voice conversation between a trucking recruiter (logistician) and a truck driver. The transcript may be in any language (English, Russian, Uzbek, etc.), may have speaker labels or not, and may contain speech-to-text mistakes.

Your job: extract the DRIVER's details and fill in the template below.

RULES:
- Output ONLY the filled template. No commentary, no explanations, no bold (**), no code fences.
- Always write the template in English, whatever language the transcript is in.
- Use "#team" template if the transcript mentions two drivers, a team, a partner/co-driver (wife, husband, brother, friend driving together). Otherwise use "#solo".
- Take facts only from the transcript. NEVER invent or guess. If a field is not mentioned, leave it blank after the colon.
- Facts about the driver come from the driver's own words. The recruiter's offers are NOT the driver's data, except Rate/Escrow/Work days/Home days when they were agreed in the conversation.
- Names: write in Latin letters, properly capitalized (First Last). If the name is unclear or likely misheard, leave it blank or put your best spelling and add "check name spelling" in Notes.
- Phone: digits in a normal format, e.g. +1 555 123 4567. If spoken as words, convert to digits. If unclear, leave blank.
- Email: if spelled out ("john dot smith at gmail dot com"), convert to john.smith@gmail.com. If unclear, leave blank.
- Experience: years and type, e.g. "3 years OTR, 1 year local".
- Rate: use what was agreed in the conversation. If nothing was said, write $0.95/mile.
- Escrow: use what was agreed. If nothing was said, write $2,500 (10 weeks).
- Work days / Home days: e.g. "3 weeks out" / "1 week home". Blank if not discussed.
- Zip code: the driver's home zip code if mentioned (5 digits). Blank otherwise.
- Ready: when the driver can start (e.g. "next Monday", "immediately", "in 2 weeks").
- English level: judge only from what the conversation says (e.g. driver says "good English", or the recruiter notes it). If not stated, leave blank.
- Work Authorization: citizen, green card, work permit/EAD, etc. Only if mentioned.
- Application status: only if stated (e.g. "interested", "will send documents", "thinking"). Otherwise blank.
- Nationality: only if mentioned.
- Notes: short, useful extras in English, separated by commas or short lines: truck/trailer preferences, endorsements (hazmat, tanker, doubles), accidents/violations, current employer, why leaving, special conditions, things to double-check. Keep it brief. Do not repeat what is already in other fields.

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

// Скачать текстовый файл (.txt), если расшифровку прислали файлом
async function downloadTextFile(fileId) {
  const meta = await tg("getFile", { file_id: fileId });
  const res = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${meta.file_path}`
  );
  if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
  return await res.text();
}

// ---------- Gemini ----------

async function askGemini(transcript) {
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
          contents: [
            {
              role: "user",
              parts: [{ text: "TRANSCRIPT:\n\n" + transcript }],
            },
          ],
          config: { systemInstruction: SYSTEM_PROMPT, temperature: 0.1 },
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
        const temporary =
          /503|429|500|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|fetch failed/i.test(
            msg
          );
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

// ---------- Обработка ----------

async function processTranscript(chatId, transcript) {
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const text = await askGemini(transcript);
    await send(chatId, text);
  } catch (err) {
    console.error("Ошибка обработки:", err);
    await send(chatId, "Ошибка обработки: " + err.message).catch(() => {});
  }
}

// Длинный текст Telegram режет на несколько сообщений подряд.
// Собираем сообщения одного чата и обрабатываем вместе через 3 секунды тишины.
const buffers = new Map();

function addToBuffer(chatId, text) {
  let buf = buffers.get(chatId);
  if (!buf) {
    buf = { chunks: [], timer: null };
    buffers.set(chatId, buf);
  }
  buf.chunks.push(text);
  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buffers.delete(chatId);
    const transcript = buf.chunks.join("\n").trim();
    if (transcript) processTranscript(chatId, transcript);
  }, 3000);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;

  if (ALLOWED.size > 0 && !ALLOWED.has(chatId)) {
    console.warn("Чужой chat_id:", chatId);
    return;
  }

  if (msg.text && msg.text.startsWith("/start")) {
    await send(
      chatId,
      "Отправь текст расшифровки разговора с водителем (или .txt файл). Я верну готовый шаблон."
    ).catch(() => {});
    return;
  }

  if (msg.text) {
    addToBuffer(chatId, msg.text);
    return;
  }

  // Расшифровка файлом .txt
  if (
    msg.document &&
    ((msg.document.mime_type || "").startsWith("text/") ||
      (msg.document.file_name || "").toLowerCase().endsWith(".txt"))
  ) {
    try {
      const text = await downloadTextFile(msg.document.file_id);
      addToBuffer(chatId, (msg.caption ? msg.caption + "\n" : "") + text);
    } catch (err) {
      console.error(err);
      await send(chatId, "Не удалось прочитать файл: " + err.message).catch(() => {});
    }
    return;
  }

  await send(chatId, "Я понимаю только текст или .txt файл с расшифровкой.").catch(() => {});
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
            await handleMessage(update.message);
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
