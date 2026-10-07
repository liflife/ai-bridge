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

const MAX_FILE_SIZE = 200 * 1024;   // 单文件 200KB
const MAX_TOTAL_SIZE = 500 * 1024;  // 总计 500KB

import { Logger, LOG_ROOT_DIR } from "../shared/logger.js";
const log = new Logger("ui", { color: "\x1b[35m" }); // 品红




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
// @ 文件引用处理
// ==========================================
function parseFileReferences(text) {
  const regex = /@(?:"([^"]+)"|([^\s@]+))/g;
  const refs = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    const p = m[1] !== undefined ? m[1] : m[2];
    if (!p) continue;
    refs.push({ full: m[0], path: p });
  }
  return refs;
}

async function loadReferencedFiles(text, workdir) {
  const refs = parseFileReferences(text);
  if (refs.length === 0) return [];

  const results = [];
  let totalSize = 0;
  const BINARY_EXTS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
    ".zip", ".rar", ".7z", ".tar", ".gz",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".woff", ".woff2", ".ttf", ".otf",
    ".class", ".jar", ".pyc",
  ]);

  for (const ref of refs) {
    const abs = path.isAbsolute(ref.path)
      ? ref.path
      : path.resolve(workdir, ref.path);

    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        results.push({ path: ref.path, abs, error: "不是文件" });
        continue;
      }
      if (stat.size > MAX_FILE_SIZE) {
        results.push({
          path: ref.path,
          abs,
          error: `文件过大 (${Math.round(stat.size / 1024)}KB)`,
        });
        continue;
      }
      if (totalSize + stat.size > MAX_TOTAL_SIZE) {
        results.push({ path: ref.path, abs, error: "超出总计限制" });
        continue;
      }
      const ext = path.extname(abs).toLowerCase();
      if (BINARY_EXTS.has(ext)) {
        results.push({ path: ref.path, abs, error: "二进制文件，跳过" });
        continue;
      }
      const content = await fs.readFile(abs, "utf-8");
      totalSize += stat.size;
      results.push({ path: ref.path, abs, content, size: stat.size });
    } catch (e) {
      results.push({ path: ref.path, abs, error: e.message });
    }
  }
  return results;
}

function buildTaskWithAttachments(originalTask, attachments) {
  const ok = attachments.filter(a => a.content !== undefined);
  if (ok.length === 0) return originalTask;

  const parts = [];
  for (const a of ok) {
    const fence = "`".repeat(3);
    parts.push(`### @${a.path}\n\n${fence}\n${a.content}\n${fence}`);
  }

  return `${originalTask}\n\n---\n\n【引用的文件】\n\n${parts.join("\n\n")}`;
}

// ==========================================
// 运行 agent
// ==========================================
app.post("/api/run", async (req, res) => {
  const { task, sessionId, site, projectKey } = req.body || {};
  log.audit("RUN_START", {
    sessionId, site, projectKey,
    taskHead: task?.slice(0, 100),
    taskLen: task?.length,
  });

  if (!task || typeof task !== "string") {
    return res.status(400).json({ error: "缺少 task 参数" });
  }
  if (!projectKey) {
    return res.status(400).json({ error: "缺少 projectKey" });
  }

  // 读项目
  let projectMeta;
  try {
    projectMeta = await readProject(projectKey);
  } catch {
    return res.status(404).json({ error: "项目不存在" });
  }

  // ★ 解析 @ 引用（注意：在 try 外面声明变量）
  let attachments = [];
  try {
    attachments = await loadReferencedFiles(task, projectMeta.path);
  } catch (e) {
    log.error("[Server] 解析 @ 引用失败:", e.message);
  }

  // ★ 附件审计
  if (attachments.length > 0) {
    log.audit("ATTACHMENTS", {
      count: attachments.length,
      files: attachments.map(a => ({
        path: a.path,
        size: a.size,
        ok: a.content !== undefined,
      })),
    });
    attachments.forEach(a => {
      if (a.error) {
        log.warn(`  📎 @${a.path}  [${a.error}]`);
      } else {
        log.info(`  📎 @${a.path}  (${(a.size / 1024).toFixed(1)}KB)`);
      }
    });
  }

  // ★ 组装最终任务
  const finalTask = buildTaskWithAttachments(task, attachments);

  // SSE
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

  // ★ 附件事件（现在可以访问 attachments 了）
  if (attachments.length > 0) {
    send("agent-event", {
      type: "attachments",
      attachments: attachments.map(a => ({
        path: a.path,
        size: a.size,
        error: a.error,
      })),
    });
  }

  running.set(taskId, { abort: () => ac.abort(), res });

  res.on("close", () => {
    if (!ac.signal.aborted) {
      try { ac.abort(); } catch {}
    }
  });

  const startedAt = Date.now();
  let finalResult = null;

  try {
    finalResult = await runAgent(finalTask, {
      site: site || "deepseek",
      sessionId,
      signal: ac.signal,
      quiet: true,
      workdir: projectMeta.path,
      onEvent: (e) => send("agent-event", e),
    });
    send("done", finalResult || { ok: true });
  } catch (err) {
    send("error", { message: err.message });
    finalResult = { ok: false, reason: "exception", message: err.message };
  } finally {
    running.delete(taskId);
    log.audit("RUN_END", {
      taskId,
      ok: finalResult?.ok,
      reason: finalResult?.reason,
      elapsed: Date.now() - startedAt,
    });
    try { res.end(); } catch {}
  }

  // 更新会话
  if (sessionId) {
    try {
      let sess;
      try {
        sess = await readSession(projectKey, sessionId);
      } catch {
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
      log.error("[Server] 更新会话失败:", e.message);
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
// 文件浏览 API（用于 @ 候选）
// ==========================================
app.get("/api/browse", async (req, res) => {
  const projectKey = String(req.query.projectKey || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const subDir = String(req.query.dir || "");

  if (!projectKey) {
    return res.status(400).json({ error: "缺少 projectKey" });
  }

  let meta;
  try {
    meta = await readProject(projectKey);
  } catch {
    return res.status(404).json({ error: "项目不存在" });
  }

  const basePath = path.resolve(meta.path);
  const targetPath = subDir ? path.resolve(basePath, subDir) : basePath;

  // 安全：不能跳出项目目录
  if (!targetPath.startsWith(basePath)) {
    return res.status(403).json({ error: "路径越界" });
  }

  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const dirs = [];
    const files = [];

    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const fullPath = path.join(targetPath, e.name);
      const relPath = subDir
        ? `${subDir.replace(/\\/g, "/")}/${e.name}`
        : e.name;

      if (e.isDirectory()) {
        dirs.push({ name: e.name, isDir: true, relPath: relPath + "/" });
      } else {
        let size = 0;
        try {
          const st = await fs.stat(fullPath);
          size = st.size;
        } catch {}
        files.push({ name: e.name, isDir: false, size, relPath });
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ entries: [...dirs, ...files] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  log.info(`Web UI: http://127.0.0.1:${PORT}`);
  log.info(`项目目录: ${PROJECTS_DIR}`);
  log.info(`日志目录: ${LOG_ROOT_DIR}/ui`);
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