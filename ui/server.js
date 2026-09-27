// ==========================================
// ui/server.js
// ==========================================
import express from "express";
import path from "path";
import os from "os";
import fs from "fs/promises";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { runAgent } from "../agent/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(os.homedir(), ".ai-bridge-agent", "projects");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// 工具
// ==========================================
function safeKey(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function listProjects() {
  await ensureDir(PROJECTS_DIR);
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const metaPath = path.join(PROJECTS_DIR, e.name, "project.json");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
      const sessDir = path.join(PROJECTS_DIR, e.name, "sessions");
      let sessionCount = 0;
      try {
        const files = await fs.readdir(sessDir);
        sessionCount = files.filter(f => f.endsWith(".json")).length;
      } catch {}
      result.push({ ...meta, key: e.name, sessionCount });
    } catch {}
  }
  result.sort((a, b) => (b.lastUsedAt || b.createdAt || "").localeCompare(a.lastUsedAt || a.createdAt || ""));
  return result;
}

async function readProject(key) {
  const metaPath = path.join(PROJECTS_DIR, key, "project.json");
  return JSON.parse(await fs.readFile(metaPath, "utf-8"));
}

async function writeProject(key, data) {
  const dir = path.join(PROJECTS_DIR, key);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(data, null, 2), "utf-8");
}

async function listProjectSessions(key) {
  const sessDir = path.join(PROJECTS_DIR, key, "sessions");
  await ensureDir(sessDir);
  const files = await fs.readdir(sessDir);
  const result = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const content = await fs.readFile(path.join(sessDir, f), "utf-8");
      result.push(JSON.parse(content));
    } catch {}
  }
  result.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return result;
}

async function readSession(key, sessionId) {
  const p = path.join(PROJECTS_DIR, key, "sessions", `${safeKey(sessionId)}.json`);
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

async function writeSession(key, sessionId, data) {
  const dir = path.join(PROJECTS_DIR, key, "sessions");
  await ensureDir(dir);
  const p = path.join(dir, `${safeKey(sessionId)}.json`);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf-8");
}

// ==========================================
// 运行中的任务
// ==========================================
const running = new Map();

// ==========================================
// 项目 API
// ==========================================

// 列出所有项目
app.get("/api/projects", async (req, res) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// 创建项目
app.post("/api/projects", async (req, res) => {
  const { name, path: projPath } = req.body || {};
  if (!name) return res.status(400).json({ error: "缺少 name" });
  if (!projPath) return res.status(400).json({ error: "缺少 path" });

  const key = safeKey(name);
  const dir = path.join(PROJECTS_DIR, key);

  // 已存在？
  try {
    await fs.access(path.join(dir, "project.json"));
    return res.status(409).json({ error: `项目 "${key}" 已存在` });
  } catch {}

  // 校验 path
  const absPath = path.resolve(projPath);
  try {
    const st = await fs.stat(absPath);
    if (!st.isDirectory()) {
      return res.status(400).json({ error: "path 不是目录" });
    }
  } catch {
    // 不存在就创建
    try {
      await fs.mkdir(absPath, { recursive: true });
    } catch (e) {
      return res.status(400).json({ error: `无法创建目录: ${e.message}` });
    }
  }

  const now = new Date().toISOString();
  const meta = {
    name,
    key,
    path: absPath,
    createdAt: now,
    lastUsedAt: now,
  };
  await writeProject(key, meta);
  await ensureDir(path.join(dir, "sessions"));

  // ★★★ 自动创建第一个会话 ★★★
  const sessionId = "s-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const firstSession = {
    sessionId,
    site: "deepseek",
    url: null,
    createdAt: now,
    updatedAt: now,
    taskCount: 0,
    taskHistory: [],
  };
  await writeSession(key, sessionId, firstSession);

  res.json({ ok: true, project: meta, firstSession });
});

// 删除项目
app.delete("/api/projects/:key", async (req, res) => {
  const key = safeKey(req.params.key);
  const dir = path.join(PROJECTS_DIR, key);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 项目详情
app.get("/api/projects/:key", async (req, res) => {
  const key = safeKey(req.params.key);
  try {
    const meta = await readProject(key);
    res.json(meta);
  } catch {
    res.status(404).json({ error: "项目不存在" });
  }
});

// ==========================================
// 会话 API
// ==========================================

// 列出项目的会话
app.get("/api/projects/:key/sessions", async (req, res) => {
  const key = safeKey(req.params.key);
  try {
    const meta = await readProject(key);
    const sessions = await listProjectSessions(key);

    // 更新 lastUsedAt
    meta.lastUsedAt = new Date().toISOString();
    await writeProject(key, meta);

    res.json({ project: meta, sessions });
  } catch (e) {
    res.status(404).json({ error: "项目不存在" });
  }
});

// 创建新会话
app.post("/api/projects/:key/sessions", async (req, res) => {
  const key = safeKey(req.params.key);
  const { sessionId, site } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "缺少 sessionId" });

  try {
    await readProject(key); // 确认项目存在
  } catch {
    return res.status(404).json({ error: "项目不存在" });
  }

  const now = new Date().toISOString();
  const data = {
    sessionId,
    site: site || "deepseek",
    url: null,
    createdAt: now,
    updatedAt: now,
    taskCount: 0,
    taskHistory: [],
  };
  await writeSession(key, sessionId, data);
  res.json({ ok: true, session: data });
});

// 会话详情
app.get("/api/projects/:key/sessions/:sessionId", async (req, res) => {
  const key = safeKey(req.params.key);
  const sessionId = req.params.sessionId;
  try {
    const data = await readSession(key, sessionId);
    res.json(data);
  } catch {
    res.status(404).json({ error: "会话不存在" });
  }
});

// 删除会话
app.delete("/api/projects/:key/sessions/:sessionId", async (req, res) => {
  const key = safeKey(req.params.key);
  const sessionId = safeKey(req.params.sessionId);
  const p = path.join(PROJECTS_DIR, key, "sessions", `${sessionId}.json`);
  try {
    await fs.unlink(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: "会话不存在" });
  }
});

// ==========================================
// 运行 agent
// ==========================================
app.post("/api/run", async (req, res) => {
  const { task, sessionId, site, projectKey } = req.body || {};
  if (!task || typeof task !== "string") {
    return res.status(400).json({ error: "缺少 task 参数" });
  }
  if (!projectKey) {
    return res.status(400).json({ error: "缺少 projectKey" });
  }

  // 读项目，拿到 path
  let projectMeta;
  try {
    projectMeta = await readProject(projectKey);
  } catch {
    return res.status(404).json({ error: "项目不存在" });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const taskId = crypto.randomUUID();
  const ac = new AbortController();

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };

  send("task-id", { taskId });
  running.set(taskId, { abort: () => ac.abort(), res });

  res.on("close", () => {
    if (!ac.signal.aborted) {
      try { ac.abort(); } catch {}
    }
  });

  const startedAt = Date.now();
  let finalResult = null;

  try {
    finalResult = await runAgent(task, {
      site: site || "deepseek",
      sessionId,
      signal: ac.signal,
      quiet: true,
      workdir: projectMeta.path,      // ★ 用项目的 path
      onEvent: (e) => send("agent-event", e),
    });
    send("done", finalResult || { ok: true });
  } catch (err) {
    send("error", { message: err.message });
    finalResult = { ok: false, reason: "exception", message: err.message };
  } finally {
    running.delete(taskId);
    try { res.end(); } catch {}
  }

  // ★ 更新会话文件
  if (sessionId) {
    try {
      let sess;
      try {
        sess = await readSession(projectKey, sessionId);
      } catch {
        // 会话不存在，创建
        const now = new Date().toISOString();
        sess = {
          sessionId,
          site: site || "deepseek",
          url: null,
          createdAt: now,
          updatedAt: now,
          taskCount: 0,
          taskHistory: [],
        };
      }

      sess.taskCount = (sess.taskCount || 0) + 1;
      sess.taskHistory = (sess.taskHistory || []).slice(-50);
      sess.taskHistory.push({
        task,
        ok: finalResult?.ok || false,
        elapsed: Date.now() - startedAt,
        answer: finalResult?.answer || null,
        at: new Date().toISOString(),
      });
      sess.updatedAt = new Date().toISOString();
      if (site) sess.site = site;

      await writeSession(projectKey, sessionId, sess);
    } catch (e) {
      console.error("[Server] 更新会话失败:", e.message);
    }
  }
});

// ==========================================
// 停止
// ==========================================
app.post("/api/abort", (req, res) => {
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: "缺少 taskId" });
  const entry = running.get(taskId);
  if (!entry) return res.json({ ok: false, error: "任务不存在或已结束" });
  try { entry.abort(); } catch {}
  res.json({ ok: true });
});

// ==========================================
// 系统信息
// ==========================================
app.get("/api/system", (req, res) => {
  res.json({
    cwd: process.cwd(),
    platform: process.platform,
    node: process.version,
    projectsDir: PROJECTS_DIR,
  });
});

// ==========================================
// 启动
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, "127.0.0.1", async () => {
  await ensureDir(PROJECTS_DIR);
  console.log("");
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║              🌐  AI Agent Web UI                  ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  地址:      http://127.0.0.1:${PORT}`);
  console.log(`  项目目录:  ${PROJECTS_DIR}`);
  console.log("");
  console.log("  提示: 请确保 server.js (8787) 和 Chrome 扩展已启动");
  console.log("");
});