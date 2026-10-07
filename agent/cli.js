#!/usr/bin/env node
// ==========================================
// agent/cli.js
// 交互式命令行 AI Agent（内联 @ 候选 + 项目/会话）
// ==========================================
import fs from "fs/promises";
import { readdirSync } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { runAgent } from "./agent.js";
import { InlinePrompt } from "./input.js";

import { Logger } from "../shared/logger.js";
const log = new Logger("agent", { color: "\x1b[32m" });

// ==========================================
// 常量
// ==========================================
const SERVER_URL = "http://127.0.0.1:8787";
const PROJECTS_DIR = path.join(os.homedir(), ".ai-bridge-agent", "projects");
const MAX_FILE_SIZE = 200 * 1024;
const MAX_TOTAL_SIZE = 500 * 1024;

// ==========================================
// 全局状态
// ==========================================
const STATE = {
  site: "deepseek",
  sessionId: "cli-" + Date.now(),
  url: null,
  createdAt: new Date().toISOString(),
  savedName: null,
  projectKey: null,
  workdir: null,
  busy: false,
  cancelling: false,
  currentAbort: null,
  taskHistory: [],
  taskCount: 0,
  startedAt: Date.now(),
  lastSessionList: [],
};

// ==========================================
// 颜色
// ==========================================
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const c = (color, text) => `${C[color]}${text}${C.reset}`;

// ==========================================
// 工具函数
// ==========================================
function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

function newSessionId() {
  return "cli-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function extractUuidFromUrl(url) {
  if (!url) return null;
  const m = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m ? m[1] : null;
}

// ==========================================
// 项目存储
// ==========================================
function getProjectDir(key) { return path.join(PROJECTS_DIR, key); }
function getProjectMetaPath(key) { return path.join(getProjectDir(key), "project.json"); }
function getSessionsDir(key) { return path.join(getProjectDir(key), "sessions"); }

async function readProject(key) {
  return JSON.parse(await fs.readFile(getProjectMetaPath(key), "utf-8"));
}

async function writeProject(key, data) {
  await fs.mkdir(getProjectDir(key), { recursive: true });
  await fs.writeFile(getProjectMetaPath(key), JSON.stringify(data, null, 2), "utf-8");
}

async function listProjects() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      result.push(JSON.parse(await fs.readFile(getProjectMetaPath(e.name), "utf-8")));
    } catch {}
  }
  result.sort((a, b) => (b.lastUsedAt || "").localeCompare(a.lastUsedAt || ""));
  return result;
}

async function findOrCreateProjectForCwd(cwd) {
  const abs = path.resolve(cwd);
  const base = sanitizeName(path.basename(abs) || "default");
  try {
    const meta = JSON.parse(await fs.readFile(getProjectMetaPath(base), "utf-8"));
    if (path.resolve(meta.path) === abs) {
      meta.lastUsedAt = new Date().toISOString();
      await writeProject(base, meta);
      return { key: base, meta };
    }
    const hash = crypto.createHash("md5").update(abs).digest("hex").slice(0, 6);
    const kh = `${base}-${hash}`;
    try {
      const m2 = JSON.parse(await fs.readFile(getProjectMetaPath(kh), "utf-8"));
      return { key: kh, meta: m2 };
    } catch {
      const now = new Date().toISOString();
      const m = { name: base, key: kh, path: abs, createdAt: now, lastUsedAt: now };
      await fs.mkdir(getSessionsDir(kh), { recursive: true });
      await writeProject(kh, m);
      return { key: kh, meta: m };
    }
  } catch {
    const now = new Date().toISOString();
    const m = { name: base, key: base, path: abs, createdAt: now, lastUsedAt: now };
    await fs.mkdir(getSessionsDir(base), { recursive: true });
    await writeProject(base, m);
    return { key: base, meta: m };
  }
}

// ==========================================
// 会话存储
// ==========================================
async function listProjectSessions(key) {
  await fs.mkdir(getSessionsDir(key), { recursive: true });
  const files = await fs.readdir(getSessionsDir(key));
  const result = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      result.push(JSON.parse(await fs.readFile(path.join(getSessionsDir(key), f), "utf-8")));
    } catch {}
  }
  result.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return result;
}

async function readSessionFile(key, name) {
  return JSON.parse(await fs.readFile(
    path.join(getSessionsDir(key), `${sanitizeName(name)}.json`), "utf-8"));
}

async function writeSessionFile(key, name, data) {
  await fs.mkdir(getSessionsDir(key), { recursive: true });
  const p = path.join(getSessionsDir(key), `${sanitizeName(name)}.json`);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf-8");
  return p;
}

async function deleteSessionFile(key, name) {
  await fs.unlink(path.join(getSessionsDir(key), `${sanitizeName(name)}.json`));
}

// ==========================================
// 服务端交互
// ==========================================
async function refreshUrlFromServer() {
  try {
    const res = await fetch(`${SERVER_URL}/v1/sessions/${encodeURIComponent(STATE.sessionId)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.url) {
        STATE.url = data.url;
        if (data.site) STATE.site = data.site;
      }
    }
  } catch {}
}

async function saveSessionToDisk(name) {
  await refreshUrlFromServer();
  return await writeSessionFile(STATE.projectKey, name, {
    sessionId: STATE.sessionId,
    site: STATE.site,
    url: STATE.url,
    createdAt: STATE.createdAt,
    updatedAt: new Date().toISOString(),
    taskCount: STATE.taskCount,
    taskHistory: STATE.taskHistory.slice(-50),
  });
}

// ==========================================
// @ 引用
// ==========================================
function parseFileReferences(text) {
  const regex = /@(?:"([^"]+)"|([^\s@]+))/g;
  const refs = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    const p = m[1] !== undefined ? m[1] : m[2];
    if (p) refs.push({ full: m[0], path: p });
  }
  return refs;
}

async function loadReferencedFiles(text) {
  const refs = parseFileReferences(text);
  if (refs.length === 0) return [];

  const results = [];
  let totalSize = 0;
  const BINARY = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
    ".zip", ".rar", ".7z", ".tar", ".gz",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".woff", ".woff2", ".ttf", ".otf",
    ".class", ".jar", ".pyc",
  ]);

  for (const ref of refs) {
    const abs = path.isAbsolute(ref.path) ? ref.path : path.resolve(STATE.workdir, ref.path);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) { results.push({ path: ref.path, abs, error: "不是文件" }); continue; }
      if (stat.size > MAX_FILE_SIZE) {
        results.push({ path: ref.path, abs, error: `文件过大` }); continue;
      }
      if (totalSize + stat.size > MAX_TOTAL_SIZE) {
        results.push({ path: ref.path, abs, error: `超出总限制` }); continue;
      }
      if (BINARY.has(path.extname(abs).toLowerCase())) {
        results.push({ path: ref.path, abs, error: "二进制" }); continue;
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

function buildTaskWithAttachments(task, atts) {
  const ok = atts.filter(a => a.content !== undefined);
  if (ok.length === 0) return task;
  const parts = ok.map(a => `### @${a.path}\n\n\`\`\`\n${a.content}\n\`\`\``);
  return `${task}\n\n---\n\n【引用的文件】\n\n${parts.join("\n\n")}`;
}

// ==========================================
// 界面
// ==========================================
function printBanner() {
  console.log("");
  console.log(c("cyan", "╔═══════════════════════════════════════════════════╗"));
  console.log(c("cyan", "║") + c("bold", "           🤖  AI Agent 命令行版                    ") + c("cyan", "║"));
  console.log(c("cyan", "╚═══════════════════════════════════════════════════╝"));
  console.log("");
  console.log(`  项目:      ${c("yellow", STATE.projectKey)}`);
  console.log(`  工作目录:  ${c("gray", STATE.workdir)}`);
  console.log(`  站点:      ${c("yellow", STATE.site)}`);
  console.log(`  会话 ID:   ${c("gray", STATE.sessionId)}`);
  if (STATE.url) console.log(`  网页 URL:  ${c("gray", STATE.url)}`);
  if (STATE.savedName) console.log(`  已保存为:  ${c("green", STATE.savedName)}`);
  console.log("");
  console.log(c("gray", "  输入 /help 查看帮助  ·  Ctrl+C 取消任务/退出"));
  console.log(c("gray", "  输入 @ 触发文件候选浮层"));
  console.log("");
}

function printHelp() {
  console.log("");
  console.log(c("cyan", "📖 命令:"));
  console.log("");
  console.log(`  ${c("yellow", "/help")}        显示帮助`);
  console.log(`  ${c("yellow", "/exit")}        退出`);
  console.log(`  ${c("yellow", "/clear")}       清屏`);
  console.log(`  ${c("yellow", "/new")}         新会话`);
  console.log(`  ${c("yellow", "/save")}        保存会话`);
  console.log(`  ${c("yellow", "/load")}        加载会话`);
  console.log(`  ${c("yellow", "/sessions")}    列出会话`);
  console.log(`  ${c("yellow", "/projects")}    列出项目`);
  console.log(`  ${c("yellow", "/project")}     切换项目`);
  console.log(`  ${c("yellow", "/site")}        切换站点`);
  console.log(`  ${c("yellow", "/status")}      当前状态`);
  console.log(`  ${c("yellow", "/history")}     任务历史`);
  console.log("");
  console.log(c("cyan", "⌨️  快捷键:"));
  console.log(`  ${c("yellow", "@")}           触发文件候选`);
  console.log(`  ${c("yellow", "↑↓")}          候选选择 / 输入历史`);
  console.log(`  ${c("yellow", "Tab/Enter")}   应用候选`);
  console.log(`  ${c("yellow", "Esc")}         关闭候选 / 清空输入`);
  console.log(`  ${c("yellow", "Ctrl+C")}      取消任务 / 退出`);
  console.log(`  ${c("yellow", "Ctrl+U")}      清空当前行`);
  console.log(`  ${c("yellow", "Ctrl+W")}      删一个词`);
  console.log("");
}

function printSites() {
  console.log("");
  console.log(c("cyan", "🌐 支持的站点:"));
  ["chatgpt", "deepseek", "claude", "gemini", "kimi"].forEach(s => {
    const m = s === STATE.site ? c("green", "  ← 当前") : "";
    console.log(`  - ${c("yellow", s)}${m}`);
  });
  console.log("");
}

function printStatus() {
  console.log("");
  console.log(c("cyan", "📊 状态:"));
  console.log(`  项目:       ${c("yellow", STATE.projectKey)}`);
  console.log(`  工作目录:   ${c("gray", STATE.workdir)}`);
  console.log(`  站点:       ${c("yellow", STATE.site)}`);
  console.log(`  会话 ID:    ${c("gray", STATE.sessionId)}`);
  if (STATE.url) console.log(`  网页 URL:   ${c("gray", STATE.url)}`);
  if (STATE.savedName) console.log(`  已保存为:   ${c("green", STATE.savedName)}`);
  console.log(`  任务数:     ${STATE.taskCount}`);
  console.log(`  运行时长:   ${formatElapsed(Date.now() - STATE.startedAt)}`);
  console.log("");
}

function printHistory() {
  console.log("");
  if (STATE.taskHistory.length === 0) {
    console.log(c("gray", "  (暂无历史)"));
    return;
  }
  console.log(c("cyan", `📜 历史 (${STATE.taskHistory.length}):`));
  STATE.taskHistory.forEach((h, i) => {
    const icon = h.ok ? c("green", "✅") : c("red", "❌");
    const first = h.task.split("\n")[0];
    const task = first.length > 60 ? first.slice(0, 57) + "..." : first;
    console.log(`  ${i + 1}. ${icon} ${task}  ${c("gray", formatElapsed(h.elapsed))}`);
  });
  console.log("");
}

// ==========================================
// 命令
// ==========================================
async function handleCommand(input) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // 每个命令
  log.audit("CLI_COMMAND", { cmd: firstLine });
  
  switch (cmd) {
    case "/help": case "/h": case "/?":
      printHelp(); break;
    case "/exit": case "/quit": case "/q":
      if (STATE.savedName) {
        try {
          await saveSessionToDisk(STATE.savedName);
          console.log(c("green", `  💾 已保存: ${STATE.savedName}`));
        } catch {}
      }
      console.log("");
      console.log(c("cyan", "  👋 再见！"));
	  // 退出
	  log.info(`CLI 退出, 会话=${STATE.sessionId}`);
      process.exit(0);
    case "/clear":
      console.clear();
      printBanner();
      break;
    case "/new":
      STATE.sessionId = newSessionId();
      STATE.url = null;
      STATE.createdAt = new Date().toISOString();
      STATE.savedName = null;
      STATE.taskHistory = [];
      STATE.taskCount = 0;
      STATE.startedAt = Date.now();
      console.log(c("green", `  ✅ 新会话: ${STATE.sessionId}`));
      break;
    case "/site":
      if (!args[0]) { console.log(c("yellow", `  当前: ${STATE.site}`)); }
      else { STATE.site = args[0]; console.log(c("green", `  ✅ 站点: ${STATE.site}`)); }
      break;
    case "/sites": printSites(); break;
    case "/status": printStatus(); break;
    case "/history": printHistory(); break;
    case "/save": await handleSave(args[0]); break;
    case "/load": await handleLoad(args[0]); break;
    case "/sessions": await handleListSessions(); break;
    case "/unsave": await handleUnsave(args[0]); break;
    case "/projects": await handleListProjects(); break;
    case "/project": await handleProject(args[0]); break;
    default:
      console.log(c("red", `  ⚠️ 未知命令: ${cmd}`));
  }
}

async function handleListProjects() {
  try {
    const list = await listProjects();
    console.log("");
    if (list.length === 0) { console.log(c("gray", "  (暂无项目)")); return; }
    console.log(c("cyan", `📂 项目 (${list.length}):`));
    list.forEach((p, i) => {
      const m = p.key === STATE.projectKey ? c("green", " ← 当前") : "";
      console.log(`  [${i + 1}] ${p.key}${m}  ${c("gray", p.path)}`);
    });
    console.log("");
  } catch (e) { console.log(c("red", `  ❌ ${e.message}`)); }
}

async function handleProject(arg) {
  if (!arg) {
    console.log(`  当前: ${c("yellow", STATE.projectKey)}`);
    console.log(`  目录: ${c("gray", STATE.workdir)}`);
    return;
  }
  const key = sanitizeName(arg);
  try {
    const meta = await readProject(key);
    const abs = path.resolve(meta.path);
    if (!(await fs.stat(abs)).isDirectory()) throw new Error("不是目录");
    STATE.projectKey = key;
    STATE.workdir = abs;
    STATE.sessionId = newSessionId();
    STATE.url = null;
    STATE.createdAt = new Date().toISOString();
    STATE.savedName = null;
    STATE.taskHistory = [];
    STATE.taskCount = 0;
    STATE.startedAt = Date.now();
    meta.lastUsedAt = new Date().toISOString();
    await writeProject(key, meta);
    console.log(c("green", `  ✅ 切换到: ${key}`));
    console.log(`  工作目录: ${c("gray", STATE.workdir)}`);
  } catch (e) {
    console.log(c("red", `  ❌ ${e.message}`));
  }
}

async function handleSave(name) {
  if (!name && STATE.savedName) name = STATE.savedName;
  if (!name) {
    await refreshUrlFromServer();
    name = extractUuidFromUrl(STATE.url) || STATE.sessionId;
  }
  name = sanitizeName(name);
  try {
    const file = await saveSessionToDisk(name);
    STATE.savedName = name;
    console.log(c("green", `  ✅ 已保存: ${name}`));
    console.log(c("gray", `  文件: ${file}`));
  } catch (e) { console.log(c("red", `  ❌ ${e.message}`)); }
}

async function handleLoad(arg) {
  if (!arg) { await handleListSessions(); return; }
  let name = arg;
  const num = parseInt(arg, 10);
  if (!isNaN(num) && String(num) === arg) {
    if (!STATE.lastSessionList || STATE.lastSessionList.length === 0) {
      STATE.lastSessionList = await listProjectSessions(STATE.projectKey);
    }
    if (num < 1 || num > STATE.lastSessionList.length) {
      console.log(c("red", `  ❌ 编号超范围`)); return;
    }
    const s = STATE.lastSessionList[num - 1];
    name = s.name || s.sessionId;
  }
  name = sanitizeName(name);
  try {
    const data = await readSessionFile(STATE.projectKey, name);
    STATE.sessionId = data.sessionId;
    STATE.site = data.site || STATE.site;
    STATE.url = data.url || null;
    STATE.taskCount = data.taskCount || 0;
    STATE.taskHistory = data.taskHistory || [];
    STATE.createdAt = data.createdAt || new Date().toISOString();
    STATE.startedAt = Date.now();
    STATE.savedName = name;

    if (STATE.url) {
      try {
        await fetch(`${SERVER_URL}/v1/sessions/bind`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: STATE.sessionId, url: STATE.url, site: STATE.site,
          }),
        });
      } catch {}
    }
    console.log(c("green", `  ✅ 已加载: ${name}`));
    if (STATE.url) console.log(c("gray", `  URL: ${STATE.url}`));
  } catch (e) { console.log(c("red", `  ❌ ${e.message}`)); }
}

async function handleListSessions() {
  try {
    const list = await listProjectSessions(STATE.projectKey);
    STATE.lastSessionList = list;
    console.log("");
    if (list.length === 0) { console.log(c("gray", "  (暂无会话)")); return; }
    console.log(c("cyan", `💾 会话 (${list.length}):`));
    list.forEach((s, i) => {
      const m = s.sessionId === STATE.sessionId ? c("green", " ← 当前") : "";
      const name = s.name || s.sessionId;
      console.log(`  [${i + 1}] ${name}${m}  ${c("gray", `${s.taskCount || 0}条`)}`);
    });
    console.log("");
  } catch (e) { console.log(c("red", `  ❌ ${e.message}`)); }
}

async function handleUnsave(name) {
  if (!name) { console.log(c("red", "  ⚠️ 用法: /unsave <name>")); return; }
  try {
    await deleteSessionFile(STATE.projectKey, sanitizeName(name));
    if (STATE.savedName === name) STATE.savedName = null;
    console.log(c("green", `  ✅ 已删除: ${name}`));
  } catch (e) { console.log(c("red", `  ❌ ${e.message}`)); }
}

// ==========================================
// 执行任务
// ==========================================
async function executeTask(task) {
  STATE.busy = true;
  STATE.cancelling = false;
  STATE.currentAbort = new AbortController();
  const t0 = Date.now();
  const taskId = ++STATE.taskCount;

  log.audit("CLI_TASK", {
  task: task.slice(0, 200),
  attachments: attachments.map(a => a.path),
  });
  
  let attachments = [];
  try { attachments = await loadReferencedFiles(task); } catch {}

  console.log("");
  console.log(c("cyan", `┌─ 任务 #${taskId} ${"─".repeat(40)}`));
  task.split("\n").forEach(l => console.log(c("cyan", "│ ") + c("gray", l)));
  if (attachments.length > 0) {
    console.log(c("cyan", "│"));
    attachments.forEach(a => {
      if (a.error) {
        console.log(c("cyan", "│ ") + c("red", `📎 @${a.path}  [${a.error}]`));
      } else {
        const kb = (a.size / 1024).toFixed(1);
        console.log(c("cyan", "│ ") + c("green", `📎 @${a.path}  (${kb}KB)`));
      }
    });
  }
  console.log(c("cyan", "└" + "─".repeat(50)));

  const finalTask = buildTaskWithAttachments(task, attachments);

  let ok = false;
  try {
    const result = await runAgent(finalTask, {
      site: STATE.site,
      sessionId: STATE.sessionId,
      signal: STATE.currentAbort.signal,
      quiet: true,
      workdir: STATE.workdir,
    });
    ok = result.ok;
    if (!result.ok) console.log(c("red", `  ❌ 失败: ${result.reason}`));
  } catch (err) {
    if (err.name === "AbortError" || /取消|abort/i.test(err.message)) {
      console.log(c("yellow", "  ⏹️  已取消"));
    } else {
      console.log(c("red", `  ❌ 异常: ${err.message}`));
    }
  } finally {
    const elapsed = Date.now() - t0;
    STATE.taskHistory.push({ task, ok, elapsed });
    STATE.busy = false;
    STATE.cancelling = false;
    STATE.currentAbort = null;
    await refreshUrlFromServer();
    if (STATE.savedName) {
      try { await saveSessionToDisk(STATE.savedName); } catch {}
    }
    console.log("");
  }
}

// ==========================================
// SIGINT（任务执行期间触发）
// ==========================================
process.on("SIGINT", () => {
  if (STATE.busy) {
    if (STATE.cancelling) {
      console.log("\n" + c("red", "  🚪 强制退出"));
      process.exit(1);
    }
    STATE.cancelling = true;
    console.log("");
    console.log(c("yellow", "  ⏹️  正在取消任务..."));
    console.log(c("gray", "  (再按一次 Ctrl+C 强制退出)"));
    try { STATE.currentAbort?.abort(); } catch {}
  } else {
    console.log("");
    console.log(c("cyan", "  👋 再见！"));
    process.exit(0);
  }
});

// ==========================================
// 启动
// ==========================================
async function initProject() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const { key, meta } = await findOrCreateProjectForCwd(process.cwd());
  STATE.projectKey = key;
  STATE.workdir = path.resolve(meta.path);
}

await initProject();

const prompt = new InlinePrompt({
  prompt: "agent> ",
  getWorkdir: () => STATE.workdir,
  maxCandidates: 8,
});

printBanner();

// 主循环
while (true) {
  let input;
  try {
    input = await prompt.start();
  } catch (e) {
    console.error("输入异常:", e.message);
    break;
  }

  if (input === null) {
    // Ctrl+C 且 buffer 为空 → 退出
    console.log("");
    console.log(c("cyan", "  👋 再见！"));
    if (STATE.savedName) {
      try { await saveSessionToDisk(STATE.savedName); } catch {}
    }
    process.exit(0);
  }

  const trimmed = String(input).trim();
  if (!trimmed) continue;

  if (trimmed.startsWith("/")) {
    const first = trimmed.split("\n")[0].trim();
    await handleCommand(first);
  } else {
    await executeTask(trimmed);
  }
}