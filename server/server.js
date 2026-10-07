import express from "express";
import { WebSocketServer } from "ws";
import crypto from "crypto";

import { Logger } from "../shared/logger.js";
const log = new Logger("server", { color: "\x1b[36m" }); // 青色

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

// ==========================================
// WebSocket 服务
// ==========================================
const wss = new WebSocketServer({ port: 8765, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("token") !== LOCAL_TOKEN) {
    ws.close();
    return;
  }

  // 如果已有扩展连接，关闭旧的
  if (extensionSocket && extensionSocket !== ws && extensionSocket.readyState === 1) {
    console.warn("[Server] 已有扩展连接，关闭旧连接");
    try { extensionSocket.close(); } catch {}
  }

  extensionSocket = ws;
  log.info("[Server] Extension connected");

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // ping 静默处理
    if (msg.type === "ping") return;

	  // 关键事件写审计
    if (msg.event === "started")  log.audit("WS_STARTED",  { requestId: msg.requestId });
    if (msg.event === "url_change") log.audit("WS_URL",     { sessionId: msg.sessionId, url: msg.url });
    if (msg.event === "done")     log.audit("WS_DONE",     { requestId: msg.requestId });
    if (msg.event === "error")    log.audit("WS_ERROR",    { requestId: msg.requestId, message: msg.message });
	
	
    // 日志：只打非 ping 的关键事件
    if (msg.event) {
      log.info("[Server] event:", msg.event, "requestId:", msg.requestId || "-");
    }

    // ---------- 特殊事件：不关联 HTTP 响应 ----------

    // URL 绑定事件
    if (msg.event === "url_change" && msg.sessionId && msg.url) {
      sessionMap.set(msg.sessionId, { url: msg.url, site: msg.site });
      log.info(`[Server] session=${msg.sessionId} -> ${msg.url}`);
      return;
    }

    // 扩展主动通知已中止
    if (msg.event === "aborted" && msg.requestId) {
      const entry = pending.get(msg.requestId);
      if (entry && !entry.res.writableEnded) {
        entry.res.write(`data: ${JSON.stringify({ event: "aborted" })}\n\n`);
        entry.res.write("data: [DONE]\n\n");
        entry.res.end();
      }
      pending.delete(msg.requestId);
      return;
    }

    // ---------- 普通事件：转发给 HTTP 响应 ----------

    const entry = pending.get(msg.requestId);
    if (!entry) return;
    const res = entry.res;
    if (res.writableEnded) {
      pending.delete(msg.requestId);
      return;
    }

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

  ws.on("error", (err) => {
    console.error("[Server] WS error:", err.message);
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 20000);

  // 只注册一次 close，统一清理
  ws.on("close", () => {
    clearInterval(pingTimer);
    // ★ 只有当前 socket 就是扩展连接时才清空，避免被旧连接误删
    if (extensionSocket === ws) {
      extensionSocket = null;
      log.info("[Server] Extension disconnected");
    }
  });
});

// ==========================================
// 串行队列，避免同一 tab 被并发操作
// ==========================================
let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}



// ==========================================
// Session 管理接口（供 CLI 使用）
// ==========================================

// 列出所有 session
app.get("/v1/sessions", (req, res) => {
  const list = [];
  for (const [sessionId, info] of sessionMap.entries()) {
    list.push({ sessionId, ...info });
  }
  res.json({ sessions: list });
});

// 查询单个 session
app.get("/v1/sessions/:sessionId", (req, res) => {
  const info = sessionMap.get(req.params.sessionId);
  if (!info) return res.status(404).json({ error: "not found" });
  res.json({ sessionId: req.params.sessionId, ...info });
});

// 手动绑定 session -> url（CLI 加载会话时调用）
app.post("/v1/sessions/bind", (req, res) => {
  const { sessionId, url, site } = req.body || {};
  if (!sessionId || !url) {
    return res.status(400).json({ error: "需要 sessionId 和 url" });
  }
  sessionMap.set(sessionId, { url, site: site || "deepseek" });
  log.info(`[Server] 手动绑定 session=${sessionId} -> ${url}`);
  res.json({ ok: true });
});

// 解绑
app.delete("/v1/sessions/:sessionId", (req, res) => {
  const ok = sessionMap.delete(req.params.sessionId);
  res.json({ ok });
});

// ==========================================
// HTTP API
// ==========================================
app.post("/v1/chat/completions", async (req, res) => {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return res.status(503).json({ error: "扩展未连接" });
  }
  const startedAt = Date.now();   // ★ 加这一行
  const requestId = crypto.randomUUID();
  const site = req.body.site || "chatgpt";
  const sessionId = req.body.session_id || "default";
  const prompt = req.body.messages?.at(-1)?.content || "";
	log.audit("HTTP_REQUEST", {
		path: "/v1/chat/completions",
		site,
		sessionId: sessionId,
		promptLen: prompt.length,
		promptHead: prompt.slice(0, 100),
	  });
  const saved = sessionMap.get(sessionId);
  const url = (!req.body.new_chat && saved && saved.url) ? saved.url : null;
  const newChat = !url;

  log.info(`[Server] 请求 sid=${sessionId} site=${site} url=${url || "(新会话)"}`);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  pending.set(requestId, { res, sessionId });

  await enqueue(() => new Promise((resolve) => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    // 发送命令给扩展
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
      console.error("[Server] 发送命令失败:", err.message);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
      pending.delete(requestId);
      return finish();
    }

    // 客户端断开（CLI 里 Ctrl+C）
    res.on("close", () => {
      if (!res.writableEnded) {
        console.warn("[Server] 客户端提前断开, requestId:", requestId);
        // ★ 通知扩展中止当前生成
        try {
          if (extensionSocket && extensionSocket.readyState === 1) {
            extensionSocket.send(JSON.stringify({
              type: "command",
              action: "abort",
              requestId,
            }));
          }
        } catch (err) {
          console.error("[Server] 发送 abort 失败:", err.message);
        }
        pending.delete(requestId);
      }
      finish();
    });

    // 超时保护：5 分钟没结果就强制释放队列
    setTimeout(() => {
      if (pending.has(requestId)) {
        console.warn("[Server] 请求超时 5 分钟, requestId:", requestId);
        const entry = pending.get(requestId);
        if (entry && !entry.res.writableEnded) {
          try {
            entry.res.write(`data: ${JSON.stringify({ error: "timeout" })}\n\n`);
            entry.res.end();
          } catch {}
        }
        pending.delete(requestId);
        finish();
      }
    }, 5 * 60 * 1000);
  }));
  
  // 记一次完成
	const elapsed = Date.now() - startedAt;
	log.audit("HTTP_RESPONSE", {
	  path: "/v1/chat/completions",
	  requestId,
	  elapsed,
	  ok: true,
	});
  
});

app.listen(8787, "127.0.0.1", () => log.info("API: http://127.0.0.1:8787"));