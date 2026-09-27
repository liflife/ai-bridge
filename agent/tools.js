// ==========================================
// agent/tools.js
// ==========================================
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";

export const TOOL_DESCRIPTIONS = `
可用工具：

【读取】
- read_file(path)
  读取文本文件，返回内容。
- read_lines(path, start, end)
  读取文件的指定行（1-based，含首尾）。适合大文件。
- head(path, n)
  读取文件前 n 行，默认 20。
- tail(path, n)
  读取文件后 n 行，默认 20。
- list_dir(path)
  列出目录内容。
- file_exists(path)
  判断文件/目录是否存在，返回 true/false。
- file_stat(path)
  获取文件/目录信息（大小、是否目录、修改时间）。

【搜索】
- search_files(pattern, path)
  按文件名模式递归查找（glob 风格，如 "**/*.js"、"*.md"）。
- grep(pattern, path, options)
  按内容搜索。pattern 是正则字符串。options 可选：
  - ignore_case: 忽略大小写
  - max_results: 最大结果数（默认 100）
  - include: 只搜匹配的文件名模式（如 "*.js"）

【写入】
- write_file(path)
  ★ 写文件的唯一方式。action_input 里只有 path 一个字段。
  文件内容用 <<<CONTENT>>> ... <<<END_CONTENT>>> 包裹，放在 JSON 之后。
- append_file(path)
  ★ 追加内容到文件末尾。同样用 <<<CONTENT>>> 包裹内容。
- mkdir(path)
  创建目录，会自动创建中间层级（类似 mkdir -p）。

【删除/移动】
- delete_file(path)
  删除文件（不可恢复）。
- delete_dir(path)
  删除目录（含所有内容，不可恢复，谨慎使用）。
- move_file(from, to)
  移动或重命名文件/目录。
- copy_file(from, to)
  复制文件。

【系统】
- exec_shell(cmd)
  执行 shell 命令（30 秒超时）。
- fetch_url(url)
  抓取网页内容，返回前 2000 字。
`;

// ==========================================
// 安全防护
// ==========================================
function assertSafePath(p) {
  if (!p || typeof p !== "string") {
    throw new Error("path 必须是非空字符串");
  }
  const resolved = path.resolve(p);

  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw new Error(`安全限制：不允许操作根目录 ${root}`);
  }

  if (process.platform === "win32") {
    if (/^[A-Za-z]:\\?$/.test(resolved)) {
      throw new Error(`安全限制：不允许操作盘符根 ${resolved}`);
    }
  }

  const home = path.resolve(process.env.USERPROFILE || process.env.HOME || "");
  if (home && resolved === home) {
    throw new Error("安全限制：不允许操作用户主目录");
  }

  return resolved;
}

// ==========================================
// glob 匹配（手写，支持 * / ** / ?）
// ==========================================
function globToRegex(glob) {
  // 转义正则特殊字符，然后替换 glob 通配符
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** 匹配任意多级（含 /）
        re += ".*";
        i++;
        // 跳过随后的 / 避免多一个斜杠
        if (glob[i + 1] === "/") i++;
      } else {
        // * 匹配单级（不含 /）
        re += "[^/\\\\]*";
      }
    } else if (c === "?") {
      re += "[^/\\\\]";
    } else if (".+^$(){}[]|\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

function normalizeSlashes(p) {
  return p.replace(/\\/g, "/");
}

// ==========================================
// 递归遍历目录（跳过常见大目录）
// ==========================================
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", "venv",
  ".idea", ".vscode", ".cache",
]);

async function* walkDir(dir, options = {}) {
  const { skipDirs = SKIP_DIRS, maxFiles = 10000 } = options;
  let count = 0;

  async function* recurse(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxFiles) return;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        yield { type: "dir", path: full, name: entry.name };
        yield* recurse(full);
      } else if (entry.isFile()) {
        count++;
        yield { type: "file", path: full, name: entry.name };
      }
    }
  }

  yield* recurse(dir);
}

// ==========================================
// 是否为文本文件（启发式）
// ==========================================
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".lib",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".class", ".jar", ".war", ".pyc", ".pyo",
]);

function isProbablyText(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return !BINARY_EXTS.has(ext);
}

// ==========================================
// 工具集
// ==========================================
export const tools = {
  // ==========================================
  // 读取
  // ==========================================
  async read_file({ path: p }) {
    const abs = assertSafePath(p);
    return await fs.readFile(abs, "utf-8");
  },

  async read_lines({ path: p, start, end }) {
    const abs = assertSafePath(p);
    const s = Math.max(1, parseInt(start) || 1);
    const e = end ? parseInt(end) : s + 200;
    const content = await fs.readFile(abs, "utf-8");
    const lines = content.split("\n");
    const slice = lines.slice(s - 1, e);
    const numbered = slice.map((line, i) => `${s + i}: ${line}`).join("\n");
    return `文件共 ${lines.length} 行，显示第 ${s}-${Math.min(e, lines.length)} 行:\n${numbered}`;
  },

  async head({ path: p, n = 20 }) {
    const abs = assertSafePath(p);
    const content = await fs.readFile(abs, "utf-8");
    const lines = content.split("\n").slice(0, parseInt(n) || 20);
    return lines.join("\n");
  },

  async tail({ path: p, n = 20 }) {
    const abs = assertSafePath(p);
    const content = await fs.readFile(abs, "utf-8");
    const all = content.split("\n");
    const lines = all.slice(-(parseInt(n) || 20));
    return lines.join("\n");
  },

  async list_dir({ path: p }) {
    const abs = assertSafePath(p);
    const items = await fs.readdir(abs, { withFileTypes: true });
    return items
      .map(i => (i.isDirectory() ? "📁 " : "📄 ") + i.name)
      .join("\n");
  },

  async file_exists({ path: p }) {
    const abs = assertSafePath(p);
    try {
      await fs.access(abs);
      return "true";
    } catch {
      return "false";
    }
  },

  async file_stat({ path: p }) {
    const abs = assertSafePath(p);
    const st = await fs.stat(abs);
    return JSON.stringify({
      path: abs,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      mtime: st.mtime.toISOString(),
      ctime: st.ctime.toISOString(),
    }, null, 2);
  },

  // ==========================================
  // 搜索
  // ==========================================
  async search_files({ pattern, path: p = "." }) {
    if (!pattern) throw new Error("缺少 pattern 参数");
    const abs = assertSafePath(p);
    const regex = globToRegex(pattern);
    const results = [];

    for await (const item of walkDir(abs)) {
      if (item.type !== "file") continue;
      const rel = normalizeSlashes(path.relative(abs, item.path));
      if (regex.test(rel) || regex.test(item.name)) {
        results.push(rel);
        if (results.length >= 200) break;
      }
    }

    if (results.length === 0) return "未找到匹配的文件";
    return `找到 ${results.length} 个文件:\n${results.join("\n")}`;
  },

  async grep({ pattern, path: p = ".", options = {} }) {
    if (!pattern) throw new Error("缺少 pattern 参数");
    const abs = assertSafePath(p);
    const ignoreCase = options?.ignore_case === true;
    const maxResults = parseInt(options?.max_results) || 100;
    const include = options?.include;

    let re;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (e) {
      throw new Error("无效的正则表达式: " + e.message);
    }

    const includeRegex = include ? globToRegex(include) : null;
    const results = [];

    for await (const item of walkDir(abs)) {
      if (item.type !== "file") continue;
      if (!isProbablyText(item.path)) continue;
      const rel = normalizeSlashes(path.relative(abs, item.path));

      if (includeRegex && !includeRegex.test(rel) && !includeRegex.test(item.name)) {
        continue;
      }

      let content;
      try {
        content = await fs.readFile(item.path, "utf-8");
      } catch {
        continue;
      }

      // 超大文件跳过
      if (content.length > 2 * 1024 * 1024) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= maxResults) {
            return `找到 ${results.length}+ 个匹配（已截断）:\n${results.join("\n")}`;
          }
        }
      }
    }

    if (results.length === 0) return "未找到匹配内容";
    return `找到 ${results.length} 处匹配:\n${results.join("\n")}`;
  },

  // ==========================================
  // 写入
  // ==========================================
  async write_file({ path: p, content }) {
    if (!p) throw new Error("缺少 path 参数");
    if (typeof content !== "string") {
      throw new Error("缺少 content，必须用 <<<CONTENT>>> 包裹文件内容");
    }
    const abs = assertSafePath(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    return `已写入 ${abs}（${content.length} 字符）`;
  },

  async append_file({ path: p, content }) {
    if (!p) throw new Error("缺少 path 参数");
    if (typeof content !== "string") {
      throw new Error("缺少 content，必须用 <<<CONTENT>>> 包裹文件内容");
    }
    const abs = assertSafePath(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, content, "utf-8");
    return `已追加到 ${abs}（${content.length} 字符）`;
  },

  async mkdir({ path: p }) {
    const abs = assertSafePath(p);
    await fs.mkdir(abs, { recursive: true });
    return `已创建目录 ${abs}`;
  },

  // ==========================================
  // 删除/移动
  // ==========================================
  async delete_file({ path: p }) {
    const abs = assertSafePath(p);
    await fs.unlink(abs);
    return `已删除文件 ${abs}`;
  },

  async delete_dir({ path: p }) {
    const abs = assertSafePath(p);
    await fs.rm(abs, { recursive: true, force: true });
    return `已删除目录 ${abs}`;
  },

  async move_file({ from, to }) {
    const absFrom = assertSafePath(from);
    const absTo = assertSafePath(to);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
    return `已移动/重命名 ${absFrom} → ${absTo}`;
  },

  async copy_file({ from, to }) {
    const absFrom = assertSafePath(from);
    const absTo = assertSafePath(to);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.copyFile(absFrom, absTo);
    return `已复制 ${absFrom} → ${absTo}`;
  },

  // ==========================================
  // 系统
  // ==========================================
  async exec_shell({ cmd }) {
    if (!cmd) throw new Error("缺少 cmd 参数");
    return await new Promise((resolve) => {
      exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve(`错误: ${err.message}\n${stderr || ""}`);
        resolve(stdout || "(无输出)");
      });
    });
  },

  async fetch_url({ url }) {
    if (!url) throw new Error("缺少 url 参数");
    const res = await fetch(url);
    const text = await res.text();
    return text.slice(0, 2000);
  },
};