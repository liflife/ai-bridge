#!/usr/bin/env node
// ==========================================
// start.js — AI Bridge 一键启动
// 同时拉起 server（8787/8765）和 ui（3000）
// ==========================================
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";


const logDir = path.join(os.homedir(), ".ai-bridge-agent", "logs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==========================================
// 颜色
// ==========================================
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

// ==========================================
// 依赖检查
// ==========================================
function checkDeps(dir, name) {
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) {
    console.error(`${C.red}[start]${C.reset} ${name} 缺少依赖: ${nm} 不存在`);
    console.error(`${C.red}[start]${C.reset} 请先运行: cd ${path.relative(process.cwd(), dir)} && npm install`);
    return false;
  }
  return true;
}

// ==========================================
// 进程管理
// ==========================================
const procs = [];
let shuttingDown = false;

function prefixLines(name, color, chunk) {
  const text = chunk.toString();
  const lines = text.split("\n");
  const last = lines.pop();

  // 匹配任意 ANSI 颜色/样式序列
  const ANSI_RE = /\x1b\[[0-9;]*m/g;

  const maybePrefix = (l) => {
    if (!l) return "";
    // ★ 先剥掉颜色码，再检测行首是否已有 [xxx]
    const stripped = l.replace(ANSI_RE, "");
    if (/^\[[\w.-]+\]/.test(stripped)) {
      // 已有前缀（logger 加的）→ 只染色，不再加
      return `${color}${l}${C.reset}`;
    }
    // 无前缀（第三方库或裸输出）→ 加上 [name]
    return `${color}[${name}]${C.reset} ${l}`;
  };

  if (lines.length > 0) {
    const out = lines.map(maybePrefix).filter(Boolean).join("\n");
    if (out) process.stdout.write(out + "\n");
  }
  if (last) process.stdout.write(maybePrefix(last));
}

function startProc(name, color, cwd, args) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  child.stdout.on("data", c => prefixLines(name, color, c));
  child.stderr.on("data", c => prefixLines(name, color, c));

  child.on("exit", (code, signal) => {
    const info = signal ? `signal=${signal}` : `code=${code}`;
    console.log(`${color}[${name}]${C.reset} 进程退出 (${info})`);
    if (!shuttingDown) {
      console.log(`${C.yellow}[start]${C.reset} 一个服务退出，正在关闭其它服务...`);
      shutdown();
    }
  });

  child.on("error", (err) => {
    console.error(`${color}[${name}]${C.reset} 启动失败: ${err.message}`);
  });

  procs.push({ name, child });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("");
  console.log(`${C.dim}[start] 正在关闭所有服务...${C.reset}`);

  for (const { child } of procs) {
    if (!child.killed) {
      try { child.kill("SIGINT"); } catch {}
    }
  }

  // 1 秒后强制结束
  setTimeout(() => {
    for (const { child } of procs) {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    process.exit(0);
  }, 1000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  for (const { child } of procs) {
    if (!child.killed) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
});

// ==========================================
// 启动
// ==========================================
console.log("");
console.log(`${C.cyan}╔═══════════════════════════════════════════════════╗${C.reset}`);
console.log(`${C.cyan}║${C.reset}${C.bold ?? ""}        🚀  AI Bridge 一键启动                     ${C.cyan}║${C.reset}`);
console.log(`${C.cyan}╚═══════════════════════════════════════════════════╝${C.reset}`);
console.log("");

// 依赖检查
const serverDir = path.join(__dirname, "server");
const uiDir = path.join(__dirname, "ui");

let ok = true;
if (!checkDeps(serverDir, "server")) ok = false;
if (!checkDeps(uiDir, "ui")) ok = false;

if (!ok) {
  console.log("");
  console.log(`${C.yellow}[start]${C.reset} 请先执行依赖安装:`);
  console.log(`        cd server && npm install`);
  console.log(`        cd ui && npm install`);
  process.exit(1);
}

// 检查扩展目录
const extDir = path.join(__dirname, "extension");
if (!fs.existsSync(path.join(extDir, "manifest.json"))) {
  console.log(`${C.yellow}[start]${C.reset} 警告: 未找到 Chrome 扩展 (extension/manifest.json)`);
}

// ---------- 启动 Bridge Server ----------
console.log(`${C.cyan}[start]${C.reset} 启动 Bridge Server (端口 8787 / 8765)...`);
startProc("server", C.cyan, serverDir, ["server.js"]);

// ---------- 启动 Web UI ----------
setTimeout(() => {
  console.log(`${C.magenta}[start]${C.reset} 启动 Web UI (端口 3000)...`);
  startProc("ui", C.magenta, uiDir, ["server.js"]);
}, 500);

// ---------- 就绪提示 ----------
// ==========================================
// 就绪提示（原 setTimeout(..., 2000) 里的内容）
// ==========================================
setTimeout(() => {


  console.log("");
  console.log(`${C.green}[start]${C.reset} 服务已启动：`);
  console.log(`        Bridge API   ${C.cyan}http://127.0.0.1:8787${C.reset}`);
  console.log(`        Web UI       ${C.magenta}http://127.0.0.1:3000${C.reset}`);
  console.log("");
  console.log(`${C.green}[start]${C.reset} 日志目录：`);
  console.log(`        ${C.dim}${logDir}${C.reset}`);
  console.log(`        ├─ ${C.cyan}server/${C.reset}   Bridge 服务日志`);
  console.log(`        ├─ ${C.magenta}ui/${C.reset}       Web UI 日志`);
  console.log(`        └─ ${C.green}agent/${C.reset}    CLI 日志`);
  console.log("");
  console.log(`${C.green}[start]${C.reset} 使用提示：`);
  console.log(`        1. 确保 Chrome 扩展已加载并登录 AI 网页`);
  console.log(`        2. 浏览器打开 ${C.magenta}http://127.0.0.1:3000${C.reset} 使用 Web UI`);
  console.log(`        3. 或另开终端运行 ${C.cyan}node agent/cli.js${C.reset} 使用 CLI`);
  console.log("");
  console.log(`${C.green}[start]${C.reset} 按 Ctrl+C 停止所有服务`);
  console.log("");
}, 2000);