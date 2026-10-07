#!/usr/bin/env node
// ==========================================
// scripts/logs.js — 查看日志
// 用法:
//   node scripts/logs.js server             # 看今天的 server 日志
//   node scripts/logs.js server --tail 50   # 最后 50 行
//   node scripts/logs.js ui --date 2026-09-28
//   node scripts/logs.js all --level ERROR  # 所有服务里的 ERROR
//   node scripts/logs.js agent --grep 工具
// ==========================================
import fs from "fs";
import path from "path";
import os from "os";

const LOG_ROOT = path.join(os.homedir(), ".ai-bridge-agent", "logs");

const args = process.argv.slice(2);
const target = args[0] || "all";

function getOpt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const dateStr = getOpt("date", new Date().toISOString().slice(0, 10));
const tailN = parseInt(getOpt("tail", "0"), 10);
const level = getOpt("level", "").toUpperCase();
const grep = getOpt("grep", "");

function listTargets() {
  if (target !== "all") return [target];
  try {
    return fs.readdirSync(LOG_ROOT).filter(d =>
      fs.statSync(path.join(LOG_ROOT, d)).isDirectory()
    );
  } catch { return []; }
}

function readLog(service) {
  const file = path.join(LOG_ROOT, service, `${dateStr}.log`);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, "utf-8");
  return content.split("\n").filter(Boolean);
}

function filterLines(lines, service) {
  let out = lines;
  if (level) {
    out = out.filter(l => l.includes(`[${level}]`));
  }
  if (grep) {
    const re = new RegExp(grep, "i");
    out = out.filter(l => re.test(l));
  }
  return out;
}

function printService(service) {
  const lines = readLog(service);
  if (lines.length === 0) {
    console.log(`\n=== ${service} (${dateStr}) — 无日志 ===\n`);
    return;
  }
  const filtered = filterLines(lines, service);
  const final = tailN > 0 ? filtered.slice(-tailN) : filtered;
  console.log(`\n=== ${service} (${dateStr}) — ${final.length} 条 ===\n`);
  for (const l of final) console.log(l);
}

const services = listTargets();
if (services.length === 0) {
  console.log(`日志目录为空: ${LOG_ROOT}`);
  process.exit(0);
}
for (const s of services) printService(s);