#!/usr/bin/env node
// ==========================================
// agent/cli.js
// 交互式命令行 AI Agent（粘贴多行 + 回车确认 + 会话保存）
// ==========================================
import readline from "readline";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { runAgent } from "./agent.js";

// ==========================================
// 常量
// ==========================================
const SERVER_URL = "http://127.0.0.1:8787";
const SESSIONS_DIR = path.join(os.homedir(), ".ai-bridge-agent", "sessions");
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
  busy: false,
  cancelling: false,
  currentAbort: null,
  taskHistory: [],
  taskCount: 0,
  startedAt: Date.now(),
  lastSessionList: [],   // 缓存最近列出的会话，供 /load <编号> 使用
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

// ★ 新增：从 URL 提取 UUID
function extractUuidFromUrl(url) {
  if (!url) return null;
  const m = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m ? m[1] : null;
}

// ==========================================
// 会话存储
// ==========================================
async function ensureSessionsDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

async function listSavedSessions() {
  await ensureSessionsDir();
  const files = await fs.readdir(SESSIONS_DIR);
  const result = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const content = await fs.readFile(path.join(SESSIONS_DIR, f), "utf-8");
      result.push(JSON.parse(content));
    } catch {}
  }
  // ★ 按 updatedAt 倒序
  result.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return result;
}

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
  await ensureSessionsDir();
  await refreshUrlFromServer();

  const data = {
    name,
    sessionId: STATE.sessionId,
    site: STATE.site,
    url: STATE.url,
    createdAt: STATE.createdAt,
    updatedAt: new Date().toISOString(),
    taskCount: STATE.taskCount,
    taskHistory: STATE.taskHistory.slice(-50),
  };

  const file = path.join(SESSIONS_DIR, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
  return file;
}

async function loadSessionFromDisk(name) {
  await ensureSessionsDir();
  const file = path.join(SESSIONS_DIR, `${name}.json`);
  const content = await fs.readFile(file, "utf-8");
  return JSON.parse(content);
}

async function deleteSessionFromDisk(name) {
  const file = path.join(SESSIONS_DIR, `${name}.json`);
  await fs.unlink(file);
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
  console.log(`  站点:      ${c("yellow", STATE.site)}`);
  console.log(`  会话 ID:   ${c("gray", STATE.sessionId)}`);
  if (STATE.url) {
    console.log(`  网页 URL:  ${c("gray", STATE.url)}`);
  }
  if (STATE.savedName) {
    console.log(`  已保存为:  ${c("green", STATE.savedName)}`);
  }
  console.log(`  工作目录:  ${c("gray", process.cwd())}`);
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
  console.log(`    ${c("yellow", "/new")}                 开始新会话（会断开当前）`);
  console.log(`    ${c("yellow", "/site <name>")}         切换站点`);
  console.log(`    ${c("yellow", "/sites")}               列出支持的站点`);
  console.log("");
  console.log(c("bold", "  保存/恢复:"));
  console.log(`    ${c("yellow", "/save [name]")}         保存会话`);
  console.log(c("gray", "        不带 name → 自动用 URL 里的 UUID"));
  console.log(`    ${c("yellow", "/sessions")}            列出所有已保存的会话（带编号）`);
  console.log(`    ${c("yellow", "/load")}                列出会话 + 提示如何选择`);
  console.log(`    ${c("yellow", "/load <编号>")}         按编号加载，如 /load 1`);
  console.log(`    ${c("yellow", "/load <name>")}         按名字加载`);
  console.log(`    ${c("yellow", "/unsave <name>")}       删除已保存的会话`);
  console.log("");
  console.log(c("gray", `  会话保存位置: ${SESSIONS_DIR}`));
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
  console.log(`  工作目录:   ${c("gray", process.cwd())}`);
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

    default:
      console.log("");
      console.log(c("red", `  ⚠️ 未知命令: ${cmd}`));
      console.log(c("gray", "  输入 /help 查看可用命令"));
      console.log("");
  }
}

// ==========================================
// 保存
// ★ 不带 name 时：优先用当前 savedName，其次从 URL 提取 UUID
// ==========================================
async function handleSave(name) {
  // 1) 不传 name：如果已保存过，就更新原来的名字
  if (!name && STATE.savedName) {
    name = STATE.savedName;
  }

  // 2) 还是不传 name：尝试从 URL 提取 UUID
  if (!name) {
    await refreshUrlFromServer();
    const uuid = extractUuidFromUrl(STATE.url);
    if (uuid) {
      name = uuid;
    } else {
      name = "auto-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      console.log("");
      console.log(c("yellow", "  ⚠️ 当前 URL 里没有 UUID，用时间戳命名"));
    }
  }

  name = sanitizeName(name);

  try {
    const file = await saveSessionToDisk(name);
    STATE.savedName = name;
    console.log("");
    console.log(c("green", `  ✅ 会话已保存: ${name}`));
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
// ★ 不带参数 → 列出列表
// ★ 数字 → 按编号
// ★ 其他 → 按名字
// ==========================================
async function handleLoad(arg) {
  // 1) 不带参数 → 列出会话
  if (!arg) {
    const list = await listSavedSessions();
    STATE.lastSessionList = list;

    console.log("");
    if (list.length === 0) {
      console.log(c("gray", "  (暂无保存的会话，先用 /save 保存当前会话)"));
      console.log("");
      return;
    }
    console.log(c("cyan", `💾 已保存的会话 (${list.length}):`));
    console.log("");
    list.forEach((s, i) => {
      const isCurrent = s.sessionId === STATE.sessionId;
      const marker = isCurrent ? c("green", " ← 当前") : "";
      const name = s.name.length > 40 ? s.name.slice(0, 37) + "..." : s.name;
      console.log(`  ${c("yellow", `[${i + 1}]`)} ${name}${marker}`);
      console.log(c("gray", `      站点: ${s.site}  任务: ${s.taskCount || 0}  更新: ${(s.updatedAt || "-").slice(0, 19)}`));
      if (s.url) {
        console.log(c("gray", `      url:  ${s.url}`));
      }
    });
    console.log("");
    console.log(c("gray", "  用法: /load <编号>  或  /load <name>"));
    console.log("");
    return;
  }

  // 2) 判断是编号还是名字
  let name = arg;
  const num = parseInt(arg, 10);
  if (!isNaN(num) && String(num) === arg) {
    if (!STATE.lastSessionList || STATE.lastSessionList.length === 0) {
      STATE.lastSessionList = await listSavedSessions();
    }
    if (num < 1 || num > STATE.lastSessionList.length) {
      console.log("");
      console.log(c("red", `  ❌ 编号 ${num} 超出范围 (1-${STATE.lastSessionList.length})`));
      console.log("");
      return;
    }
    name = STATE.lastSessionList[num - 1].name;
  }

  name = sanitizeName(name);

  // 3) 加载
  try {
    const data = await loadSessionFromDisk(name);

    STATE.sessionId = data.sessionId;
    STATE.site = data.site || STATE.site;
    STATE.url = data.url || null;
    STATE.taskCount = data.taskCount || 0;
    STATE.taskHistory = data.taskHistory || [];
    STATE.createdAt = data.createdAt || new Date().toISOString();
    STATE.startedAt = Date.now();
    STATE.savedName = name;

    // 通知 server 绑定
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

// ==========================================
// 列出所有会话（带编号）
// ==========================================
async function handleListSessions() {
  try {
    const list = await listSavedSessions();
    STATE.lastSessionList = list;

    console.log("");
    if (list.length === 0) {
      console.log(c("gray", "  (暂无保存的会话)"));
      console.log(c("gray", "  用 /save 保存当前会话"));
      console.log("");
      return;
    }
    console.log(c("cyan", `💾 已保存的会话 (${list.length}):`));
    console.log("");
    list.forEach((s, i) => {
      const isCurrent = s.sessionId === STATE.sessionId;
      const marker = isCurrent ? c("green", " ← 当前") : "";
      const name = s.name.length > 40 ? s.name.slice(0, 37) + "..." : s.name;
      console.log(`  ${c("yellow", `[${i + 1}]`)} ${name}${marker}`);
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
    await deleteSessionFromDisk(name);
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

    // 任务完成后刷新 url
    await refreshUrlFromServer();

    // 自动更新已保存的会话
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

printBanner();
rl.prompt();

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