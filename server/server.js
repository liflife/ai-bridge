import express from "express";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const LOCAL_TOKEN = "LOCAL_TOKEN";
const pending = new Map();       // requestId -> { res, sessionId }
const sessionMap = new Map();    // sessionId -> { url, site }
let extensionSocket = null;

const wss = new WebSocketServer({ port: 8765, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("token") !== LOCAL_TOKEN) { ws.close(); return; }

  extensionSocket = ws;
  console.log("[Server] Extension connected");

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
	console.log("[Server] message msg:",msg);
    if (msg.type === "ping") return;

    // URL 绑定事件
    if (msg.event === "url_change" && msg.sessionId && msg.url) {
      sessionMap.set(msg.sessionId, { url: msg.url, site: msg.site });
      console.log(`[Server] session=${msg.sessionId} -> ${msg.url}`);
      return;
    }

    const entry = pending.get(msg.requestId);
    if (!entry) return;
    const res = entry.res;
    if (res.writableEnded) { pending.delete(msg.requestId); return; }

    if (msg.event === "started") {
      res.write(`data: ${JSON.stringify({ event: "started" })}\n\n`);
    }
    if (msg.event === "delta") {
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: msg.text } }]
      })}\n\n`);
    }
    if (msg.event === "done") {
      res.write("data: [DONE]\n\n");
      res.end();
      pending.delete(msg.requestId);
    }
    if (msg.event === "error") {
      res.write(`data: ${JSON.stringify({ error: msg.message })}\n\n`);
      res.end();
      pending.delete(msg.requestId);
    }
  });

  ws.on("close", () => { extensionSocket = null; });
  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 20000);
  ws.on("close", () => clearInterval(pingTimer));
});

// 串行队列，避免同一 tab 被并发操作
let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

app.post("/v1/chat/completions", async (req, res) => {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return res.status(503).json({ error: "扩展未连接" });
  }

  const requestId = crypto.randomUUID();
  const site = req.body.site || "chatgpt";
  const sessionId = req.body.session_id || "default";
  const prompt = req.body.messages?.at(-1)?.content || "";

  const saved = sessionMap.get(sessionId);
  const url = (!req.body.new_chat && saved && saved.url) ? saved.url : null;
  const newChat = !url;

  console.log(`[Server] 请求 sid=${sessionId} site=${site} url=${url || "(新会话)"}`);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  pending.set(requestId, { res, sessionId });

  await enqueue(() => new Promise((resolve) => {
    try {
      extensionSocket.send(JSON.stringify({
        type: "command",
        action: "chat",
        requestId,
        site,
        sessionId,
        url,
        newChat,
        prompt,
      }));
    } catch (err) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
      pending.delete(requestId);
      return resolve();
    }
    res.on("close", () => {
      if (!res.writableEnded) pending.delete(requestId);
      resolve();
    });
  }));
});

app.listen(8787, "127.0.0.1", () => console.log("API: http://127.0.0.1:8787"));