// ==========================================
// shared/logger.js
// 轻量日志：文件 + 控制台双写，按天轮转
// ==========================================
import fs from "fs";
import path from "path";
import os from "os";

const RESET = "\x1b[0m";
const LOG_ROOT = process.env.AI_BRIDGE_LOG_DIR
  || path.join(os.homedir(), ".ai-bridge-agent", "logs");
const KEEP_DAYS = parseInt(process.env.AI_BRIDGE_LOG_KEEP_DAYS || "7", 10);

// ---------- 时间 ----------
function dateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function timeStr(d = new Date()) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}
function fullTs(d = new Date()) {
  return `${dateStr(d)} ${timeStr(d)}`;
}

// ---------- 清理旧日志 ----------
function cleanOldLogs(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const f of files) {
      const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
      if (!m) continue;
      const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
      if (t < cutoff) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
}

// ---------- 序列化 ----------
function safeStringify(obj, maxLen = 2000) {
  if (obj === undefined) return "";
  if (typeof obj === "string") return obj.length > maxLen ? obj.slice(0, maxLen) + "…" : obj;
  try {
    let s = JSON.stringify(obj);
    if (s && s.length > maxLen) s = s.slice(0, maxLen) + "…";
    return s;
  } catch {
    return String(obj);
  }
}

// ==========================================
// Logger
// ==========================================
export class Logger {
  constructor(name, { color = null, console = true } = {}) {
    this.name = name;
    this.color = color;
    this.console = console;
    this.dir = path.join(LOG_ROOT, name);
    this._ensureDir();
    this._maybeClean();
  }

  _ensureDir() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
  }

  _maybeClean() {
    if (this._cleaned) return;
    this._cleaned = true;
    cleanOldLogs(this.dir);
    // 每 6 小时清理一次（unref 防止阻塞进程退出）
    const t = setInterval(() => cleanOldLogs(this.dir), 6 * 3600 * 1000);
    if (t.unref) t.unref();
  }

  _file() {
    return path.join(this.dir, `${dateStr()}.log`);
  }

  _write(level, args) {
    const parts = args.map(a =>
      typeof a === "string" ? a : safeStringify(a)
    );
    const body = parts.join(" ");
    const line = `[${fullTs()}] [${level}] ${body}`;

    // 文件
    try {
      fs.appendFileSync(this._file(), line + "\n", "utf-8");
    } catch {}

    // 控制台
    if (this.console) {
      const prefix = this.color
        ? `${this.color}[${this.name}]${RESET}`
        : `[${this.name}]`;
      if (level === "ERROR") {
        console.error(`${prefix} ${line}`);
      } else if (level === "WARN") {
        console.warn(`${prefix} ${line}`);
      } else {
        console.log(`${prefix} ${line}`);
      }
    }
  }

  info(...args)  { this._write("INFO",  args); }
  warn(...args)  { this._write("WARN",  args); }
  error(...args) { this._write("ERROR", args); }
  debug(...args) {
    if (process.env.AI_BRIDGE_DEBUG) this._write("DEBUG", args);
  }

  // 结构化审计日志：专门用于记录业务事件
  audit(event, data) {
    const line = `[${fullTs()}] [AUDIT] ${event} ${safeStringify(data, 4000)}`;
    try {
      fs.appendFileSync(this._file(), line + "\n", "utf-8");
    } catch {}
    if (this.console) {
      const prefix = this.color
        ? `${this.color}[${this.name}]${RESET}`
        : `[${this.name}]`;
      console.log(`${prefix} ${line}`);
    }
  }
}

// 全局单例工厂
const _instances = new Map();
export function getLogger(name, opts) {
  if (!_instances.has(name)) {
    _instances.set(name, new Logger(name, opts));
  }
  return _instances.get(name);
}

export const LOG_ROOT_DIR = LOG_ROOT;