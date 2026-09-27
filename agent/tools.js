// ==========================================
// agent/tools.js
// ==========================================
import fs from "fs/promises";
import { exec } from "child_process";

export const TOOL_DESCRIPTIONS = `
可用工具：

- read_file(path)
  读取文本文件，返回其内容。

- write_file(path)
  ★ 写文件的唯一方式。action_input 里只有 path 一个字段。
  文件内容不放在 JSON 里，而是用特殊标记 <<<CONTENT>>> ... <<<END_CONTENT>>> 包裹。
  详细格式见系统提示的【写文件格式】。

- list_dir(path)
  列出目录内容。

- exec_shell(cmd)
  执行 shell 命令（30 秒超时）。

- fetch_url(url)
  抓取网页内容，返回前 2000 字。
`;

export const tools = {
  async read_file({ path }) {
    if (!path) throw new Error("缺少 path 参数");
    return await fs.readFile(path, "utf-8");
  },

  async write_file({ path, content }) {
    if (!path) throw new Error("缺少 path 参数");
    if (typeof content !== "string") {
      throw new Error("缺少 content，必须用 <<<CONTENT>>> 包裹文件内容");
    }
    await fs.writeFile(path, content, "utf-8");
    return `已写入 ${path}（${content.length} 字符）。`;
  },

  async list_dir({ path }) {
    if (!path) throw new Error("缺少 path 参数");
    const items = await fs.readdir(path, { withFileTypes: true });
    return items
      .map(i => (i.isDirectory() ? "📁 " : "📄 ") + i.name)
      .join("\n");
  },

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