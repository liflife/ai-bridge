#!/usr/bin/env node
// ==========================================
// agent/cli.js
// 交互式命令行 AI Agent（项目/会话 + 多行 + abort）
// ==========================================
import readline from "readline";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { runAgent } from "./agent.js";

// ==========================================
// 常量
// ==========================================
const SERVER_URL = "http://127.0.0.1:8787";
const PROJECTS_DIR = path.join(os.homedir(), ".ai-bridge-agent", "projects");
const DEBOUNCE_MS = 300;

// ==========================================
// 全局状态
// ==========================================
const STATE = {
  site: "deepseek",
  sessionId: "cli-" + Date.now(),
  url: null,
  createdAt: new Date().toISOString(),
  savedName: null,
  projectKey: null,       // ★ 当前项目 key
  workdir: null,          // ★ 由 project 决定
  busy: false,
  cancelling: false,
  currentAbort: null,
  taskHistory: [],
  taskCount: 0,
  startedAt: Date.now(),
  lastSessionList: [],
  lastProjectList: [],
};

// ==========================================
// 输入缓冲
// ==========================================
const INPUT = {
  buffer: [],
  timer: null,
  multilineMode: false,
  processing: false,
};

// ==========================================
// ANSI 颜色
// ==========================================
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
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
function getProjectDir(key) {
  return path.join(PROJECTS_DIR, key);
}
function getProjectMetaPath(key) {
  return path.join(getProjectDir(key), "project.json");
}
function getSessionsDir(key) {
  return path.join(getProjectDir(key), "sessions");
}

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
      const meta = JSON.parse(await fs.readFile(getProjectMetaPath(e.name), "utf-8"));
      result.push(meta);
    } catch {}
  }
  result.sort((a, b) => (b.lastUsedAt || "").localeCompare(a.lastUsedAt || ""));
  return result;
}

async function ensureProject(key, workdir) {
  const dir = getProjectDir(key);
  await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
  const metaPath = getProjectMetaPath(key);
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    meta.lastUsedAt = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    return meta;
  } catch {
    const now = new Date().toISOString();
    const meta = {
      name: key,
      key,
      path: workdir,
      createdAt: now,
      lastUsedAt: now,
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    return meta;
  }
}

// 从 cwd 派生项目：basename，冲突则加 hash
async function findOrCreateProjectForCwd(cwd) {
  const abs = path.resolve(cwd);
  const base = sanitizeName(path.basename(abs) || "default");

  // 1) 尝试 base
  try {
    const meta = JSON.parse(await fs.readFile(getProjectMetaPath(base), "utf-8"));
    if (path.resolve(meta.path) === abs) {
      // path 一致，直接复用
      meta.lastUsedAt = new Date().toISOString();
      await writeProject(base, meta);
      return { key: base, meta };
    }
    // path 不一致 → 用 base-hash
    const hash = crypto.createHash("md5").update(abs).digest("hex").slice(0, 6);
    const keyWithHash = `${base}-${hash}`;
    try {
      const meta2 = JSON.parse(await fs.readFile(getProjectMetaPath(keyWithHash), "utf-8"));
      return { key: keyWithHash, meta: meta2 };
    } catch {
      const now = new Date().toISOString();
      const m = {
        name: base,
        key: keyWithHash,
        path: abs,
        createdAt: now,
        lastUsedAt: now,
      };
      await fs.mkdir(getSessionsDir(keyWithHash), { recursive: true });
      await writeProject(keyWithHash, m);
      return { key: keyWithHash, meta: m };
    }
  } catch {
    // base 不存在，直接创建
    const now = new Date().toISOString();
    const m = {
      name: base,
      key: base,
      path: abs,
      createdAt: now,
      lastUsedAt: now,
    };
    await fs.mkdir(getSessionsDir(base), { recursive: true });
    await writeProject(base, m);
    return { key: base, meta: m };
  }
}

// ==========================================
// 会话存储（基于项目）
// ==========================================
async function listProjectSessions(key) {
  await fs.mkdir(getSessionsDir(key), { recursive: true });
  const files = await fs.readdir(getSessionsDir(key));
  const result = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const content = await fs.readFile(path.join(getSessionsDir(key), f), "utf-8");
      result.push(JSON.parse(content));
    } catch {}
  }
  result.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return result;
}

async function readSessionFile(key, name) {
  const p = path.join(getSessionsDir(key), `${sanitizeName(name)}.json`);
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

async function writeSessionFile(key, name, data) {
  await fs.mkdir(getSessionsDir(key), { recursive: true });
  const p = path.join(getSessionsDir(key), `${sanitizeName(name)}.json`);
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf-8");
  return p;
}

async function deleteSessionFile(key, name) {
  const p = path.join(getSessionsDir(key), `${sanitizeName(name)}.json`);
  await fs.unlink(p);
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

// ==========================================
// 保存/加载（基于项目）
// ==========================================
async function saveSessionToDisk(name) {
  await refreshUrlFromServer();

  const data = {
    sessionId: STATE.sessionId,
    site: STATE.site,
    url: STATE.url,
    createdAt: STATE.createdAt,
    updatedAt: new Date().toISOString(),
    taskCount: STATE.taskCount,
    taskHistory: STATE.taskHistory.slice(-50),
  };

  return await writeSessionFile(STATE.projectKey, name, data);
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
  if (STATE.url) {
    console.log(`  网页 URL:  ${c("gray", STATE.url)}`);
  }
  if (STATE.savedName) {
    console.log(`  已保存为:  ${c("green", STATE.savedName)}`);
  }
  console.log("");
  console.log(c("gray", "  输入 /help 查看帮助  ·  Ctrl+C 取消任务/退出"));
  console.log(c("gray", "  粘贴多行后按回车确认发送"));
  console.log("");
}

function printHelp() {
  console.log("");
  console.log(c("cyan", "📖 可用命令:"));
  console.log("");
  console.log(c("bold", "  基础:"));
  console.log(`    ${c("yellow", "/help")}                显示此帮助`);
  console.log(`    ${c("yellow", "/exit")} ${c("gray", "或")} ${c("yellow", "/quit")}       退出`);
  console.log(`    ${c("yellow", "/clear")}               清屏`);
  console.log(`    ${c("yellow", "/status")}              显示当前状态`);
  console.log(`    ${c("yellow", "/history")}             显示任务历史`);
  console.log("");
  console.log(c("bold", "  会话:"));
  console.log(`    ${c("yellow", "/new")}                 开始新会话`);
  console.log(`    ${c("yellow", "/site <name>")}         切换站点`);
  console.log(`    ${c("yellow", "/sites")}               列出支持的站点`);
  console.log("");
  console.log(c("bold", "  项目:"));
  console.log(`    ${c("yellow", "/projects")}            列出所有项目`);
  console.log(`    ${c("yellow", "/project")}             显示当前项目`);
  console.log(`    ${c("yellow", "/project <key>")}       切换到指定项目`);
  console.log("");
  console.log(c("bold", "  保存/恢复（当前项目下）:"));
  console.log(`    ${c("yellow", "/save [name]")}         保存会话（不带 name → 用 URL 的 UUID）`);
  console.log(`    ${c("yellow", "/sessions")}            列出当前项目的会话`);
  console.log(`    ${c("yellow", "/load")}                列出会话`);
  console.log(`    ${c("yellow", "/load <编号>")}         按编号加载，如 /load 1`);
  console.log(`    ${c("yellow", "/load <name>")}         按名字加载`);
  console.log(`    ${c("yellow", "/unsave <name>")}       删除会话`);
  console.log("");
  console.log(c("gray", `  项目根目录: ${PROJECTS_DIR}`));
  console.log("");
}

function printSites() {
  console.log("");
  console.log(c("cyan", "🌐 支持的站点:"));
  console.log("");
  ["chatgpt", "deepseek", "claude", "gemini", "kimi"].forEach(s => {
    const marker = s === STATE.site ? c("green", "  ← 当前") : "";
    console.log(`  - ${c("yellow", s)}${marker}`);
  });
  console.log("");
}

function printStatus() {
  console.log("");
  console.log(c("cyan", "📊 当前状态:"));
  console.log("");
  console.log(`  项目:       ${c("yellow", STATE.projectKey)}`);
  console.log(`  工作目录:   ${c("gray", STATE.workdir)}`);
  console.log(`  站点:       ${c("yellow", STATE.site)}`);
  console.log(`  会话 ID:    ${c("gray", STATE.sessionId)}`);
  if (STATE.url) {
    console.log(`  网页 URL:   ${c("gray", STATE.url)}`);
  } else {
    console.log(`  网页 URL:   ${c("gray", "(尚未生成)")}`);
  }
  if (STATE.savedName) {
    console.log(`  已保存为:   ${c("green", STATE.savedName)}`);
  }
  console.log(`  任务数:     ${STATE.taskCount}`);
  console.log(`  运行时长:   ${formatElapsed(Date.now() - STATE.startedAt)}`);
  console.log("");
}

function printHistory() {
  console.log("");
  if (STATE.taskHistory.length === 0) {
    console.log(c("gray", "  (暂无任务历史)"));
    console.log("");
    return;
  }
  console.log(c("cyan", `📜 任务历史 (${STATE.taskHistory.length}):`));
  console.log("");
  STATE.taskHistory.forEach((h, i) => {
    const icon = h.ok ? c("green", "✅") : c("red", "❌");
    const time = c("gray", formatElapsed(h.elapsed));
    const firstLine = h.task.split("\n")[0];
    const task = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
    const extra = h.task.includes("\n") ? c("gray", ` [${h.task.split("\n").length}行]`) : "";
    console.log(`  ${i + 1}. ${icon} ${task}${extra}  ${time}`);
  });
  console.log("");
}

// ==========================================
// 命令处理
// ==========================================
async function handleCommand(input) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "/help": case "/h": case "/?":
      printHelp();
      break;

    case "/exit": case "/quit": case "/q":
      if (STATE.savedName) {
        try {
          await saveSessionToDisk(STATE.savedName);
          console.log("");
          console.log(c("green", `  💾 已自动保存会话: ${STATE.savedName}`));
        } catch (e) {
          console.log(c("yellow", `  ⚠️ 自动保存失败: ${e.message}`));
        }
      }
      console.log("");
      console.log(c("cyan", "  👋 再见！"));
      console.log("");
      process.exit(0);
      break;

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
      console.log("");
      console.log(c("green", `  ✅ 新会话: ${STATE.sessionId}`));
      console.log(c("gray", "  (尚未保存，用 /save 保存)"));
      console.log("");
      break;

    case "/site":
      if (args.length === 0) {
        console.log("");
        console.log(c("yellow", `  当前站点: ${STATE.site}`));
        console.log(c("gray", "  用法: /site <name>"));
        console.log("");
      } else {
        STATE.site = args[0];
        console.log("");
        console.log(c("green", `  ✅ 已切换到站点: ${STATE.site}`));
        console.log("");
      }
      break;

    case "/sites":
      printSites();
      break;

    case "/status":
      printStatus();
      break;

    case "/history":
      printHistory();
      break;

    case "/save":
      await handleSave(args[0]);
      break;

    case "/load":
      await handleLoad(args[0]);
      break;

    case "/sessions":
      await handleListSessions();
      break;

    case "/unsave":
      await handleUnsave(args[0]);
      break;

    case "/projects":
      await handleListProjects();
      break;

    case "/project":
      await handleProject(args[0]);
      break;

    default:
      console.log("");
      console.log(c("red", `  ⚠️ 未知命令: ${cmd}`));
      console.log(c("gray", "  输入 /help 查看可用命令"));
      console.log("");
  }
}

// ==========================================
// 项目命令
// ==========================================
async function handleListProjects() {
  try {
    const list = await listProjects();
    STATE.lastProjectList = list;
    console.log("");
    if (list.length === 0) {
      console.log(c("gray", "  (暂无项目)"));
      console.log("");
      return;
    }
    console.log(c("cyan", `📂 项目列表 (${list.length}):`));
    console.log("");
    list.forEach((p, i) => {
      const isCurrent = p.key === STATE.projectKey;
      const marker = isCurrent ? c("green", " ← 当前") : "";
      console.log(`  ${c("yellow", `[${i + 1}]`)} ${p.key}${marker}`);
      console.log(c("gray", `      path: ${p.path}`));
      console.log(c("gray", `      更新: ${(p.lastUsedAt || "-").slice(0, 19)}`));
    });
    console.log("");
    console.log(c("gray", "  用 /project <key> 切换"));
    console.log("");
  } catch (e) {
    console.log(c("red", `  ❌ ${e.message}`));
  }
}

async function handleProject(arg) {
  if (!arg) {
    console.log("");
    console.log(`  当前项目: ${c("yellow", STATE.projectKey)}`);
    console.log(`  工作目录: ${c("gray", STATE.workdir)}`);
    console.log(c("gray", "  用法: /project <key>  或  /projects 查看所有"));
    console.log("");
    return;
  }
  const key = sanitizeName(arg);
  try {
    const meta = await readProject(key);
    const abs = path.resolve(meta.path);
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) throw new Error("不是目录");

    STATE.projectKey = key;
    STATE.workdir = abs;
    // 切换项目 → 新会话
    STATE.sessionId = newSessionId();
    STATE.url = null;
    STATE.createdAt = new Date().toISOString();
    STATE.savedName = null;
    STATE.taskHistory = [];
    STATE.taskCount = 0;
    STATE.startedAt = Date.now();

    // 更新 lastUsedAt
    meta.lastUsedAt = new Date().toISOString();
    await writeProject(key, meta);

    console.log("");
    console.log(c("green", `  ✅ 已切换到项目: ${key}`));
    console.log(`  工作目录: ${c("gray", STATE.workdir)}`);
    console.log(`  会话 ID:  ${c("gray", STATE.sessionId)}`);
    console.log("");
  } catch (e) {
    console.log("");
    console.log(c("red", `  ❌ 无法切换项目: ${e.message}`));
    console.log(c("gray", "  用 /projects 查看所有项目"));
    console.log("");
  }
}

// ==========================================
// 保存
// ==========================================
async function handleSave(name) {
  if (!name && STATE.savedName) {
    name = STATE.savedName;
  }

  if (!name) {
    await refreshUrlFromServer();
    const uuid = extractUuidFromUrl(STATE.url);
    if (uuid) {
      name = uuid;
    } else {
      name = STATE.sessionId;
      console.log("");
      console.log(c("yellow", "  ⚠️ 当前 URL 里没有 UUID，用 sessionId 命名"));
    }
  }

  name = sanitizeName(name);

  try {
    const file = await saveSessionToDisk(name);
    STATE.savedName = name;
    console.log("");
    console.log(c("green", `  ✅ 会话已保存: ${name}`));
    console.log(c("gray", `  项目: ${STATE.projectKey}`));
    console.log(c("gray", `  sessionId: ${STATE.sessionId}`));
    if (STATE.url) {
      console.log(c("gray", `  网页 URL:  ${STATE.url}`));
    }
    console.log(c("gray", `  文件: ${file}`));
    console.log(c("gray", `  (后续任务完成后会自动更新)`));
    console.log("");
  } catch (e) {
    console.log("");
    console.log(c("red", `  ❌ 保存失败: ${e.message}`));
    console.log("");
  }
}

// ==========================================
// 加载
// ==========================================
async function handleLoad(arg) {
  if (!arg) {
    await handleListSessions();
    return;
  }

  let name = arg;
  const num = parseInt(arg, 10);
  if (!isNaN(num) && String(num) === arg) {
    if (!STATE.lastSessionList || STATE.lastSessionList.length === 0) {
      STATE.lastSessionList = await listProjectSessions(STATE.projectKey);
    }
    if (num < 1 || num > STATE.lastSessionList.length) {
      console.log("");
      console.log(c("red", `  ❌ 编号 ${num} 超出范围 (1-${STATE.lastSessionList.length})`));
      console.log("");
      return;
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
            sessionId: STATE.sessionId,
            url: STATE.url,
            site: STATE.site,
          }),
        });
      } catch (e) {
        console.log(c("yellow", `  ⚠️ 无法通知 server 绑定: ${e.message}`));
      }
    }

    console.log("");
    console.log(c("green", `  ✅ 已加载会话: ${name}`));
    console.log(`  项目:      ${c("yellow", STATE.projectKey)}`);
    console.log(`  工作目录:  ${c("gray", STATE.workdir)}`);
    console.log(`  站点:      ${c("yellow", STATE.site)}`);
    console.log(`  会话 ID:   ${c("gray", STATE.sessionId)}`);
    if (STATE.url) {
      console.log(`  网页 URL:  ${c("gray", STATE.url)}`);
    } else {
      console.log(c("yellow", `  ⚠️ 该会话没有保存 url，下次任务将新建网页会话`));
    }
    console.log(`  任务数:    ${STATE.taskCount}`);
    console.log("");
  } catch (e) {
    console.log("");
    console.log(c("red", `  ❌ 加载失败: ${e.message}`));
    console.log(c("gray", "  用 /load 查看所有会话"));
    console.log("");
  }
}

async function handleListSessions() {
  try {
    const list = await listProjectSessions(STATE.projectKey);
    STATE.lastSessionList = list;

    console.log("");
    if (list.length === 0) {
      console.log(c("gray", `  (项目 "${STATE.projectKey}" 暂无保存的会话)`));
      console.log(c("gray", "  用 /save 保存当前会话"));
      console.log("");
      return;
    }
    console.log(c("cyan", `💾 项目 "${STATE.projectKey}" 的会话 (${list.length}):`));
    console.log("");
    list.forEach((s, i) => {
      const isCurrent = s.sessionId === STATE.sessionId;
      const marker = isCurrent ? c("green", " ← 当前") : "";
      const name = (s.name || s.sessionId);
      const showName = name.length > 40 ? name.slice(0, 37) + "..." : name;
      console.log(`  ${c("yellow", `[${i + 1}]`)} ${showName}${marker}`);
      console.log(c("gray", `      站点: ${s.site}  任务: ${s.taskCount || 0}  更新: ${(s.updatedAt || "-").slice(0, 19)}`));
      if (s.url) {
        console.log(c("gray", `      url:  ${s.url}`));
      }
    });
    console.log("");
    console.log(c("gray", "  用 /load <编号> 或 /load <name> 加载"));
    console.log("");
  } catch (e) {
    console.log(c("red", `  ❌ ${e.message}`));
  }
}

async function handleUnsave(name) {
  if (!name) {
    console.log("");
    console.log(c("red", "  ⚠️ 用法: /unsave <name>"));
    console.log("");
    return;
  }
  name = sanitizeName(name);
  try {
    await deleteSessionFile(STATE.projectKey, name);
    if (STATE.savedName === name) STATE.savedName = null;
    console.log("");
    console.log(c("green", `  ✅ 已删除会话: ${name}`));
    console.log("");
  } catch (e) {
    console.log("");
    console.log(c("red", `  ❌ 删除失败: ${e.message}`));
    console.log("");
  }
}

// ==========================================
// 执行任务
// ==========================================
async function executeTask(task) {
  STATE.busy = true;
  STATE.cancelling = false;
  STATE.currentAbort = new AbortController();
  const taskStartedAt = Date.now();
  const taskId = ++STATE.taskCount;

  console.log("");
  console.log(c("cyan", `┌─ 任务 #${taskId} ──────────────────────────────────`));
  task.split("\n").forEach(l => {
    console.log(c("cyan", "│ ") + c("gray", l));
  });
  console.log(c("cyan", "└───────────────────────────────────────────────────"));

  let ok = false;
  try {
    const result = await runAgent(task, {
      site: STATE.site,
      sessionId: STATE.sessionId,
      signal: STATE.currentAbort.signal,
      quiet: true,
      workdir: STATE.workdir,        // ★ 从项目来
    });
    ok = result.ok;
    if (!result.ok) {
      console.log("");
      console.log(c("red", `  ❌ 任务失败: ${result.reason}`));
    }
  } catch (err) {
    console.log("");
    if (err.name === "AbortError" || /取消|abort/i.test(err.message)) {
      console.log(c("yellow", "  ⏹️  任务已取消"));
    } else {
      console.log(c("red", `  ❌ 任务异常: ${err.message}`));
    }
  } finally {
    if (cancelTimer) {
      clearTimeout(cancelTimer);
      cancelTimer = null;
    }
    const elapsed = Date.now() - taskStartedAt;
    STATE.taskHistory.push({ task, ok, elapsed });
    STATE.busy = false;
    STATE.cancelling = false;
    STATE.currentAbort = null;

    await refreshUrlFromServer();

    if (STATE.savedName) {
      try {
        await saveSessionToDisk(STATE.savedName);
      } catch (e) {
        console.log(c("yellow", `  ⚠️ 自动保存失败: ${e.message}`));
      }
    }

    console.log("");
  }
}

// ==========================================
// 初始化：确定项目
// ==========================================
async function initProject() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });

  const cwd = process.cwd();
  const { key, meta } = await findOrCreateProjectForCwd(cwd);

  STATE.projectKey = key;
  STATE.workdir = path.resolve(meta.path);
}

// ==========================================
// REPL
// ==========================================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: c("cyan", "agent> "),
  historySize: 500,
  removeHistoryDuplicates: true,
});

let cancelTimer = null;

// ==========================================
// 输入缓冲
// ==========================================
function resetDebounce() {
  if (INPUT.timer) clearTimeout(INPUT.timer);
  INPUT.timer = setTimeout(onDebounceEnd, DEBOUNCE_MS);
}

function onDebounceEnd() {
  INPUT.timer = null;
  if (INPUT.processing) return;
  if (INPUT.buffer.length === 0) return;

  if (INPUT.buffer.length === 1) {
    processInput();
    return;
  }

  if (INPUT.buffer[INPUT.buffer.length - 1] === "") {
    INPUT.buffer.pop();
    processInput();
    return;
  }

  INPUT.multilineMode = true;
  const n = INPUT.buffer.length;
  process.stdout.write("\n");
  console.log(c("yellow", `  📥 已接收 ${n} 行，按回车发送（Ctrl+C 取消）`));
}

async function processInput() {
  if (INPUT.processing) return;

  const raw = INPUT.buffer.join("\n");
  INPUT.buffer = [];
  INPUT.multilineMode = false;
  if (INPUT.timer) {
    clearTimeout(INPUT.timer);
    INPUT.timer = null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    if (!STATE.busy) rl.prompt();
    return;
  }

  if (STATE.busy) {
    console.log(c("gray", "  ⏳ 任务执行中，请稍候..."));
    return;
  }

  INPUT.processing = true;
  try {
    if (trimmed.startsWith("/")) {
      const firstLine = trimmed.split("\n")[0].trim();
      await handleCommand(firstLine);
    } else {
      await executeTask(trimmed);
    }
  } catch (err) {
    console.error(c("red", `  ❌ 输入处理异常: ${err.message}`));
  } finally {
    INPUT.processing = false;
    if (!STATE.busy) rl.prompt();
  }
}

rl.on("line", (line) => {
  const isBlank = line.trim() === "";

  if (INPUT.multilineMode) {
    if (isBlank) {
      console.log(c("green", "  ✅ 已确认，发送中..."));
      processInput();
    } else {
      INPUT.buffer.push(line);
      console.log(c("gray", `  (+ 第 ${INPUT.buffer.length} 行，按回车发送)`));
    }
    return;
  }

  INPUT.buffer.push(line);
  resetDebounce();
});

// ==========================================
// SIGINT / close
// ==========================================
rl.on("SIGINT", () => {
  if (!STATE.busy && INPUT.buffer.length > 0) {
    INPUT.buffer = [];
    INPUT.multilineMode = false;
    if (INPUT.timer) {
      clearTimeout(INPUT.timer);
      INPUT.timer = null;
    }
    console.log("");
    console.log(c("yellow", "  🧹 已清空未发送的输入"));
    rl.prompt();
    return;
  }

  if (!STATE.busy) {
    (async () => {
      if (STATE.savedName) {
        try {
          await saveSessionToDisk(STATE.savedName);
          console.log("");
          console.log(c("green", `  💾 已自动保存会话: ${STATE.savedName}`));
        } catch {}
      }
      console.log("");
      console.log(c("cyan", "  👋 再见！"));
      console.log("");
      process.exit(0);
    })();
    return;
  }

  if (STATE.cancelling) {
    console.log("");
    console.log(c("red", "  🚪 强制退出"));
    process.exit(1);
  }

  STATE.cancelling = true;
  console.log("");
  console.log(c("yellow", "  ⏹️  正在取消当前任务..."));
  console.log(c("gray", "  (再按一次 Ctrl+C 强制退出)"));

  try { STATE.currentAbort?.abort(); } catch {}

  cancelTimer = setTimeout(() => {
    if (STATE.busy) {
      console.log("");
      console.log(c("yellow", "  ⚠️  取消超时，强制释放"));
      STATE.busy = false;
      STATE.cancelling = false;
      STATE.currentAbort = null;
      rl.prompt();
    }
  }, 8000);
});

rl.on("close", () => {
  (async () => {
    if (STATE.savedName) {
      try { await saveSessionToDisk(STATE.savedName); } catch {}
    }
    console.log("");
    console.log(c("cyan", "  👋 再见！"));
    console.log("");
    process.exit(0);
  })();
});

// ==========================================
// 启动
// ==========================================
await initProject();
printBanner();
rl.prompt();