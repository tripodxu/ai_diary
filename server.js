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

  /* 生成日记：有 GEMINI_API_KEY 时调用真模型，否则 501 由前端回退本地模板 */
  if (req.method === "POST" && pathname === "/api/diary") {
    let body;
    try { body = JSON.parse((await readBody(req)).toString("utf8")); }
    catch (e) { return json(res, 400, { error: "bad json" }); }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return json(res, 501, { error: "GEMINI_API_KEY not configured" });
    const transcript = (Array.isArray(body.transcript) ? body.transcript : [])
      .map(t => (t && t.who === "U" ? "用户: " : "Gemini: ") + String(t && t.text || ""))
      .join("\n");
    const photo = String(body.photo || "一张照片");
    const prompt = [
      `你是「秒秒的AI日记」应用的日记撰写助手。用户和 Gemini 围绕一张照片（${photo}）对话。`,
      `请根据聊天记录，以用户的第一人称视角写一篇温柔的中文日记：`,
      `一个 4-8 字的标题，3 个自然段（每段 60-110 字，贴合聊天里的情绪）。`,
      `只输出 JSON：{"title":"...","body":["段1","段2","段3"]}`,
      ``, `聊天记录：`, transcript,
    ].join("\n");
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
          }),
        }
      );
      if (!resp.ok) throw new Error("upstream " + resp.status);
      const data = await resp.json();
      const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
        && data.candidates[0].content.parts && data.candidates[0].content.parts[0].text || "";
      const m = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(m ? m[0] : text);
      if (!parsed.title || !Array.isArray(parsed.body) || !parsed.body.length) throw new Error("bad shape");
      return json(res, 200, parsed);
    } catch (e) {
      return json(res, 502, { error: String(e && e.message || e) });
    }
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
