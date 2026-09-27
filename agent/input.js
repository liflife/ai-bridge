// ==========================================
// agent/input.js
// 内联输入提示，支持 @ 文件候选浮层
// ==========================================
import readline from "readline";
import { readdirSync, statSync } from "fs";
import path from "path";

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

function charWidth(ch) {
  const code = ch.codePointAt(0);
  if (
    (code >= 0x1100 && code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7A3) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE30 && code <= 0xFE6F) ||
    (code >= 0xFF00 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    (code >= 0x20000 && code <= 0x2FFFD) ||
    (code >= 0x30000 && code <= 0x3FFFD)
  ) return 2;
  return 1;
}

function displayWidth(str) {
  let w = 0;
  for (const ch of str) w += charWidth(ch);
  return w;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export class InlinePrompt {
  constructor(opts = {}) {
    this.promptText = opts.prompt || "> ";
    this.getWorkdir = opts.getWorkdir || (() => process.cwd());
    this.maxCandidates = opts.maxCandidates || 8;
    this.history = [];

    this.buffer = "";
    this.cursor = 0;
    this.historyIdx = -1;
    this.historyDraft = "";

    this.candidates = [];
    this.candidateIdx = 0;
    this.showCandidates = false;
    this.candidateStartPos = -1;

    this.resolveFn = null;
    this.isActive = false;

    // bracketed paste
    this.inPaste = false;
    this.pasteBuf = "";
    this.suppressKeyUntil = 0;
  }

  start() {
    return new Promise((resolve) => {
      this.resolveFn = resolve;
      this.isActive = true;
      this.buffer = "";
      this.cursor = 0;
      this.historyIdx = -1;
      this.showCandidates = false;
      this.candidates = [];
      this.inPaste = false;
      this.pasteBuf = "";

      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); } catch {}
      }
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      readline.emitKeypressEvents(process.stdin);

      // 启用 bracketed paste
      process.stdout.write("\x1b[?2004h");

      this.onKey = this.handleKeypress.bind(this);
      this.onData = this.handleData.bind(this);
      process.stdin.on("keypress", this.onKey);
      process.stdin.on("data", this.onData);

      this.render();
    });
  }

  finish(value) {
    if (!this.isActive) return;
    this.isActive = false;
    try { process.stdin.removeListener("keypress", this.onKey); } catch {}
    try { process.stdin.removeListener("data", this.onData); } catch {}
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.stdin.pause();
    process.stdout.write("\x1b[?2004l");

    // 光标此时在"输入行"，从这里清到屏幕底
    process.stdout.write("\r\x1b[J");

    const fn = this.resolveFn;
    this.resolveFn = null;

    if (value !== null && value !== undefined && String(value).trim() !== "") {
      this.history.push(String(value));
      // 回显，让输出可以正常滚动
      process.stdout.write(C.cyan + this.promptText + C.reset + String(value) + "\n");
    }

    fn(value);
  }

  // ---------- 渲染 ----------
  //
  // 关键约定：
  //   每次 render 开始时，光标位于"输入行的第 0 列"
  //   每次 render 结束时，光标回到"输入行的输入列"
  //   这样下一帧只做一件事：\r\x1b[J 把当前位置清到屏幕底，再重画
  //
  render() {
    // 1. 光标回到输入行行首，清到屏幕底
    process.stdout.write("\r\x1b[J");

    // 2. 计算可用高度
    const termHeight = process.stdout.rows || 24;
    // 渲染块 = 输入行(1) + 分隔线(1) + 候选(N) + 提示(1) = N + 3
    // 保守：不超过 termHeight - 1
    const maxVisible = Math.max(1, Math.min(this.maxCandidates, termHeight - 4));

    // 3. 画输入行
    const dispBuf = this.buffer.replace(/\n/g, "↵");
    process.stdout.write(C.cyan + this.promptText + C.reset + dispBuf);

    // 4. 画候选
    if (this.showCandidates && this.candidates.length > 0) {
      const total = this.candidates.length;
      const showCount = Math.min(maxVisible, total);

      // 滑动窗口起点
      let start = 0;
      if (this.candidateIdx >= showCount) {
        start = this.candidateIdx - showCount + 1;
      }
      const visible = this.candidates.slice(start, start + showCount);

      // 分隔线
      process.stdout.write("\n" + C.dim + "  " + "─".repeat(50) + C.reset);

      // 候选项
      for (let i = 0; i < visible.length; i++) {
        const idx = start + i;
        const item = visible[i];
        const isSelected = idx === this.candidateIdx;
        const icon = item.isDir ? "📁" : "📄";
        const nameStr = item.name.length > 44 ? item.name.slice(0, 41) + "..." : item.name;
        const sizeStr = item.isDir ? "" : formatSize(item.size);

        let line;
        if (isSelected) {
          line = `  ${C.yellow}▶${C.reset} ${icon} ${C.yellow}${nameStr}${C.reset}` +
                 (sizeStr ? `  ${C.gray}${sizeStr}${C.reset}` : "");
        } else {
          line = `    ${icon} ${nameStr}` +
                 (sizeStr ? `  ${C.gray}${sizeStr}${C.reset}` : "");
        }
        process.stdout.write("\n" + line);
      }

      // 提示行
      const hint =
        `  ${C.dim}↑↓ 选择 · Tab/Enter 确认 · Esc 关闭 · ` +
        `${this.candidateIdx + 1}/${total}${C.reset}`;
      process.stdout.write("\n" + hint);

      // 5. 光标回到"输入行"
      //    已经向下画了 showCount + 2 行（分隔 + N + 提示）
      const downLines = showCount + 2;
      if (downLines > 0) {
        process.stdout.write(`\x1b[${downLines}A`);
      }
    }

    // 6. 光标从行首移动到"输入列"
    process.stdout.write("\r");
    const promptWidth = displayWidth(this.promptText);
    const beforeCursor = dispBuf.slice(0, this.cursor);
    const col = promptWidth + displayWidth(beforeCursor);
    if (col > 0) process.stdout.write(`\x1b[${col}C`);
  }

  // ---------- 候选 ----------
  computeCandidates() {
    const beforeCursor = this.buffer.slice(0, this.cursor);
    const match = beforeCursor.match(/@([^\s@]*)$/);
    if (!match) {
      this.showCandidates = false;
      this.candidates = [];
      this.candidateStartPos = -1;
      return;
    }

    const partial = match[1];
    this.candidateStartPos = this.cursor - match[0].length;

    const workdir = this.getWorkdir();
    const dirPart = path.dirname(partial) || ".";
    const basePart = path.basename(partial);
    const absDir = path.isAbsolute(dirPart)
      ? dirPart
      : path.resolve(workdir, dirPart);

    try {
      const entries = readdirSync(absDir, { withFileTypes: true });
      const dirs = [];
      const files = [];
      const lowerBase = basePart.toLowerCase();

      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (lowerBase && !e.name.toLowerCase().startsWith(lowerBase)) continue;

        const fullPath = path.join(absDir, e.name);
        const relDir = dirPart === "." ? "" : dirPart.replace(/\\/g, "/") + "/";

        if (e.isDirectory()) {
          dirs.push({ name: e.name, isDir: true, relPath: relDir + e.name + "/" });
        } else {
          let size = 0;
          try { size = statSync(fullPath).size; } catch {}
          files.push({ name: e.name, isDir: false, size, relPath: relDir + e.name });
        }
      }

      this.candidates = [...dirs, ...files];
      if (this.candidates.length > 0) {
        this.showCandidates = true;
        if (this.candidateIdx >= this.candidates.length) this.candidateIdx = 0;
      } else {
        this.showCandidates = false;
        this.candidateIdx = 0;
      }
    } catch {
      this.candidates = [];
      this.showCandidates = false;
      this.candidateIdx = 0;
    }
  }

  applyCandidate() {
    const item = this.candidates[this.candidateIdx];
    if (!item) return;

    const before = this.buffer.slice(0, this.candidateStartPos);
    const after = this.buffer.slice(this.cursor);
    const insert = "@" + item.relPath;

    if (item.isDir) {
      this.buffer = before + insert + after;
      this.cursor = before.length + insert.length;
      this.candidateIdx = 0;
      this.computeCandidates();
    } else {
      this.buffer = before + insert + " " + after;
      this.cursor = before.length + insert.length + 1;
      this.showCandidates = false;
      this.candidates = [];
      this.candidateIdx = 0;
    }
    this.render();
  }

  // ---------- 粘贴 ----------
  handleData(chunk) {
    if (this.inPaste) {
      const endIdx = chunk.indexOf("\x1b[201~");
      if (endIdx >= 0) {
        this.pasteBuf += chunk.slice(0, endIdx);
        const content = this.pasteBuf;
        this.inPaste = false;
        this.pasteBuf = "";
        this.insertPaste(content);
        this.suppressKeyUntil = Date.now() + 60;
      } else {
        this.pasteBuf += chunk;
      }
      return;
    }

    const startIdx = chunk.indexOf("\x1b[200~");
    if (startIdx >= 0) {
      const rest = chunk.slice(startIdx + 6);
      const endIdx = rest.indexOf("\x1b[201~");
      if (endIdx >= 0) {
        const content = rest.slice(0, endIdx);
        this.insertPaste(content);
        this.suppressKeyUntil = Date.now() + 60;
      } else {
        this.inPaste = true;
        this.pasteBuf = rest;
      }
    }
  }

  insertPaste(content) {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.buffer =
      this.buffer.slice(0, this.cursor) + normalized + this.buffer.slice(this.cursor);
    this.cursor += normalized.length;
    this.historyIdx = -1;
    this.computeCandidates(); // 粘贴后可能更新候选
    this.render();
  }

  // ---------- 按键 ----------
  handleKeypress(str, key) {
    if (!this.isActive) return;
    if (Date.now() < this.suppressKeyUntil) return;

    // Ctrl+C
    if (key && key.ctrl && key.name === "c") {
      if (this.buffer) {
        this.buffer = "";
        this.cursor = 0;
        this.showCandidates = false;
        this.candidates = [];
        this.render();
      } else {
        this.finish(null);
      }
      return;
    }

    // Escape
    if (key && key.name === "escape") {
      if (this.showCandidates) {
        this.showCandidates = false;
        this.candidates = [];
      } else if (this.buffer) {
        this.buffer = "";
        this.cursor = 0;
      }
      this.render();
      return;
    }

    // 候选模式导航
    if (this.showCandidates) {
      if (key.name === "up") {
        this.candidateIdx = Math.max(0, this.candidateIdx - 1);
        this.render();
        return;
      }
      if (key.name === "down") {
        this.candidateIdx = Math.min(this.candidates.length - 1, this.candidateIdx + 1);
        this.render();
        return;
      }
      if (key.name === "tab" || key.name === "return") {
        this.applyCandidate();
        return;
      }
    } else {
      // 历史导航
      if (key.name === "up") {
        if (this.history.length === 0) return;
        if (this.historyIdx === -1) {
          this.historyDraft = this.buffer;
          this.historyIdx = this.history.length - 1;
        } else if (this.historyIdx > 0) {
          this.historyIdx--;
        } else return;
        this.buffer = this.history[this.historyIdx];
        this.cursor = this.buffer.length;
        this.render();
        return;
      }
      if (key.name === "down") {
        if (this.historyIdx === -1) return;
        if (this.historyIdx < this.history.length - 1) {
          this.historyIdx++;
          this.buffer = this.history[this.historyIdx];
        } else {
          this.historyIdx = -1;
          this.buffer = this.historyDraft;
        }
        this.cursor = this.buffer.length;
        this.render();
        return;
      }
    }

    // Enter
    if (key.name === "return") {
      this.finish(this.buffer);
      return;
    }

    // Backspace
    if (key.name === "backspace") {
      if (this.cursor > 0) {
        this.buffer =
          this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor--;
        if (this.showCandidates || /@[^\s@]*$/.test(this.buffer.slice(0, this.cursor))) {
          this.computeCandidates();
        }
        this.render();
      }
      return;
    }

    // Delete
    if (key.name === "delete") {
      if (this.cursor < this.buffer.length) {
        this.buffer =
          this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        this.render();
      }
      return;
    }

    // 移动
    if (key.name === "left") {
      if (this.cursor > 0) {
        this.cursor--;
        if (this.showCandidates) this.computeCandidates();
        this.render();
      }
      return;
    }
    if (key.name === "right") {
      if (this.cursor < this.buffer.length) {
        this.cursor++;
        if (this.showCandidates) this.computeCandidates();
        this.render();
      }
      return;
    }

    // Home / End
    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.cursor = 0;
      this.render();
      return;
    }
    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.cursor = this.buffer.length;
      this.render();
      return;
    }

    // Ctrl+U
    if (key.ctrl && key.name === "u") {
      this.buffer = "";
      this.cursor = 0;
      this.showCandidates = false;
      this.candidates = [];
      this.render();
      return;
    }

    // Ctrl+W
    if (key.ctrl && key.name === "w") {
      const before = this.buffer.slice(0, this.cursor);
      const m = before.match(/\S+\s*$/);
      if (m) {
        this.buffer =
          this.buffer.slice(0, this.cursor - m[0].length) + this.buffer.slice(this.cursor);
        this.cursor -= m[0].length;
        if (this.showCandidates) this.computeCandidates();
        this.render();
      }
      return;
    }

    // 普通字符
    if (str && !key?.ctrl && !key?.meta) {
      const printable = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
      if (printable) {
        this.buffer =
          this.buffer.slice(0, this.cursor) + printable + this.buffer.slice(this.cursor);
        this.cursor += printable.length;
        this.historyIdx = -1;

        if (this.showCandidates || /@[^\s@]*$/.test(this.buffer.slice(0, this.cursor))) {
          this.computeCandidates();
        }
        this.render();
      }
    }
  }
}