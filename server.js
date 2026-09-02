/* ============================================================
   秒秒的AI日记 —— 后端记忆服务
   零依赖 Node HTTP 服务器：
   · 静态托管 index.html
   · REST API：记忆的保存 / 读取 / 删除（持久化到 data/）
   启动： node server.js   （默认 http://localhost:8765）
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8765;
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const THUMBS = path.join(DATA, "thumbs");
const DB = path.join(DATA, "memories.json");

/* ============================================================
   AI 适配层 — 兼容 DeepSeek / OpenAI / Moonshot / Qwen / Ollama / Gemini
   ============================================================
   环境变量：
     AI_PROVIDER  = gemini | deepseek | openai | moonshot | qwen | openrouter | ollama | custom
     AI_BASE_URL  = https://api.deepseek.com   (custom/openai 系必填，其余内置映射)
     AI_MODEL     = deepseek-chat              (各提供商给默认值)
     AI_API_KEY   = sk-...
   ============================================================ */
const PROVIDER_MAP = {
  gemini:     { base: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.0-flash", mode: "gemini" },
  deepseek:   { base: "https://api.deepseek.com", model: "deepseek-chat", mode: "openai" },
  openai:     { base: "https://api.openai.com", model: "gpt-4o-mini", mode: "openai" },
  moonshot:   { base: "https://api.moonshot.cn", model: "moonshot-v1-8k", mode: "openai" },
  qwen:       { base: "https://dashscope.aliyuncs.com/compatible-mode", model: "qwen-turbo", mode: "openai" },
  openrouter: { base: "https://openrouter.ai/api", model: "openai/gpt-4o-mini", mode: "openai" },
  ollama:     { base: "http://localhost:11434", model: "llama3", mode: "openai" },
};

function getAIConfig() {
  const providerId = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const preset = PROVIDER_MAP[providerId];
  const providerName = preset ? providerId : "custom";
  return {
    provider: providerName,
    base:  process.env.AI_BASE_URL || (preset ? preset.base : ""),
    model: process.env.AI_MODEL   || (preset ? preset.model : ""),
    key:   process.env.AI_API_KEY || process.env.GEMINI_API_KEY || "",
    mode:  preset ? preset.mode : "openai",
  };
}

const SYSTEM_PROMPT = `你是「秒秒的AI日记」里的 AI 伙伴，性格温暖、善解人意、像朋友一样聊天。
用户会和你分享一张照片，请围绕照片真诚交流，引导用户说出感受和故事。
回复控制在 1-3 句，温柔自然，偶尔用 emoji。`;

async function aiChat(messages, photo) {
  const cfg = getAIConfig();
  if (!cfg.base || !cfg.key) throw new Error("AI not configured");

  if (cfg.mode === "gemini") {
    /* Gemini generateContent 兼容路径 */
    const transcript = messages.map(m =>
      (m.role === "user" ? "用户: " : "Gemini: ") + m.content
    ).join("\n");
    const prompt = `${SYSTEM_PROMPT}\n\n照片：${photo || "一张照片"}\n\n对话记录：\n${transcript}\n\n请回复用户最后的话：`;
    const r = await fetch(`${cfg.base}/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.85 } }),
    });
    if (!r.ok) throw new Error("gemini upstream " + r.status);
    const data = await r.json();
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  }

  /* OpenAI 兼容路径（DeepSeek / OpenAI / Moonshot / Qwen / OpenRouter / Ollama） */
  const apiMessages = [
    { role: "system", content: SYSTEM_PROMPT + (photo ? `\n用户分享了一张「${photo}」的照片。` : "") },
    ...messages,
  ];
  const r = await fetch(`${cfg.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages: apiMessages, temperature: 0.85, max_tokens: 300 }),
  });
  if (!r.ok) { const t = await r.text().catch(()=>""); throw new Error(`upstream ${r.status}: ${t.slice(0,120)}`); }
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function aiDiary(transcript, photo) {
  const cfg = getAIConfig();
  if (!cfg.base || !cfg.key) throw new Error("AI not configured");

  const transcriptText = transcript.map(t =>
    (t.who === "U" ? "用户: " : "Gemini: ") + t.text
  ).join("\n");

  const prompt = [
    `你是「秒秒的AI日记」应用的日记撰写助手。用户和 AI 围绕一张照片（${photo}）对话。`,
    `请根据聊天记录，以用户的第一人称视角写一篇温柔的中文日记：`,
    `一个 4-8 字的标题，3 个自然段（每段 60-110 字，贴合聊天里的情绪）。`,
    `只输出 JSON：{"title":"...","body":["段1","段2","段3"]}`,
    ``, `聊天记录：`, transcriptText,
  ].join("\n");

  if (cfg.mode === "gemini") {
    const r = await fetch(`${cfg.base}/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
      }),
    });
    if (!r.ok) throw new Error("gemini upstream " + r.status);
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text);
  }

  const r = await fetch(`${cfg.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: prompt }],
      temperature: 0.9, max_tokens: 400, response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error("upstream " + r.status);
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || "";
  const m2 = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m2 ? m2[0] : text);
}

for (const dir of [DATA, THUMBS]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, "[]", "utf8");

/* ---------- 数据库（JSON 文件） ---------- */
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); }
  catch (e) { return []; }
}
function writeDB(list) {
  fs.writeFileSync(DB, JSON.stringify(list, null, 2), "utf8");
}

/* ---------- 工具 ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webm": "video/webm", ".mp4": "video/mp4", ".woff2": "font/woff2",
};
function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, buf) => {
    if (err) { json(res, 404, { error: "not found" }); return; }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "max-age=3600",
    });
    res.end(buf);
  });
}

/* ---------- API 路由 ---------- */
async function handleAPI(req, res, url) {
  const { pathname } = url;

  /* 记忆列表 */
  if (req.method === "GET" && pathname === "/api/memories") {
    return json(res, 200, { memories: readDB() });
  }

  /* 保存一条记忆（含日记与缩略图 dataURL） */
  if (req.method === "POST" && pathname === "/api/memories") {
    let body;
    try { body = JSON.parse((await readBody(req)).toString("utf8")); }
    catch (e) { return json(res, 400, { error: "bad json" }); }

    const name = String(body.name || "").slice(0, 60) || "未命名的回忆";
    const music = String(body.music || "Memory · 回忆").slice(0, 60);
    const diary = body.diary && typeof body.diary === "object" ? body.diary : null;
    const list = readDB();

    /* 同名记忆视为更新，避免重复 */
    let rec = list.find(m => m.name === name);
    if (!rec) {
      rec = { id: "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, music, diary, created: Date.now() };
      list.unshift(rec);
    } else {
      rec.music = music; rec.diary = diary; rec.updated = Date.now();
    }

    if (typeof body.thumb === "string" && body.thumb.startsWith("data:image/")) {
      try {
        const b64 = body.thumb.slice(body.thumb.indexOf(",") + 1);
        fs.writeFileSync(path.join(THUMBS, rec.id + ".jpg"), Buffer.from(b64, "base64"));
        rec.thumb = "/api/memories/" + rec.id + "/thumb";
      } catch (e) { /* 缩略图失败不阻塞 */ }
    }
    writeDB(list);
    return json(res, 200, rec);
  }

  /* 生成日记（统一适配层） */
  if (req.method === "POST" && pathname === "/api/diary") {
    let body;
    try { body = JSON.parse((await readBody(req)).toString("utf8")); }
    catch (e) { return json(res, 400, { error: "bad json" }); }
    try {
      const parsed = await aiDiary(body.transcript || [], body.photo);
      if (!parsed.title || !Array.isArray(parsed.body) || !parsed.body.length) throw new Error("bad shape");
      return json(res, 200, parsed);
    } catch (e) {
      return json(res, 502, { error: String(e && e.message || e) });
    }
  }

  /* AI 问答（chat 模式） */
  if (req.method === "POST" && pathname === "/api/chat") {
    let body;
    try { body = JSON.parse((await readBody(req)).toString("utf8")); }
    catch (e) { return json(res, 400, { error: "bad json" }); }
    try {
      const reply = await aiChat(body.messages || [], body.photo);
      return json(res, 200, { reply });
    } catch (e) {
      return json(res, 502, { error: String(e && e.message || e) });
    }
  }

  /* AI 状态查询（前端显示模型名） */
  if (req.method === "GET" && pathname === "/api/ai-status") {
    const cfg = getAIConfig();
    return json(res, 200, {
      provider: cfg.provider,
      model: cfg.model || null,
      configured: !!(cfg.base && cfg.key),
    });
  }

  /* 删除一条记忆 */
  let m;
  if ((req.method === "DELETE") && (m = pathname.match(/^\/api\/memories\/([\w-]+)$/))) {
    const id = m[1];
    const list = readDB().filter(x => x.id !== id);
    writeDB(list);
    fs.unlink(path.join(THUMBS, id + ".jpg"), () => {});
    return json(res, 200, { ok: true });
  }

  /* 缩略图 */
  if (req.method === "GET" && (m = pathname.match(/^\/api\/memories\/([\w-]+)\/thumb$/))) {
    const file = path.join(THUMBS, m[1] + ".jpg");
    if (!file.startsWith(THUMBS)) return json(res, 403, { error: "forbidden" });
    return serveFile(res, file);
  }

  return json(res, 404, { error: "unknown api" });
}

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  try {
    if (url.pathname.startsWith("/api/")) return await handleAPI(req, res, url);

    /* 静态文件 */
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "") p = "/index.html";
    const filePath = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!filePath.startsWith(ROOT)) return json(res, 403, { error: "forbidden" });
    return serveFile(res, filePath);
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log("==========================================================");
  console.log("  秒秒的AI日记 · MIAOMIAO GUO'S AI GARDEN");
  console.log("  ➜  http://localhost:" + PORT);
  console.log("  记忆持久化目录: " + DATA);
  console.log("==========================================================");
});
