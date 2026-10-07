// ==========================================
// agent/agent.js
// ==========================================
import { chat } from "./llm.js";
import { tools, TOOL_DESCRIPTIONS } from "./tools.js";
import os from "os";
import path from "path";
import fs from "fs/promises";

import { Logger } from "../shared/logger.js";
const log = new Logger("agent", { color: "\x1b[32m" }); // 绿色

// ==========================================
// ★ 方案 B：同一 sessionId 只发一次完整 System Prompt
// ==========================================
const PROMPT_SENT = new Set();

// 供调试用：清空缓存（下次会重发完整 prompt）
export function resetPromptCache() {
  PROMPT_SENT.clear();
}

// ==========================================
// 收集系统信息（接受 workdir）
// ==========================================
function collectSystemInfo(workdir) {
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  const cwd = workdir || process.cwd();
  const home = os.homedir();
  const tmpdir = os.tmpdir();
  const nodeVersion = process.version;
  const date = new Date();

  let platformName;
  if (platform === "win32") platformName = "Windows";
  else if (platform === "darwin") platformName = "macOS";
  else if (platform === "linux") platformName = "Linux";
  else platformName = platform;

  const sep = path.sep;

  const pathStyle = platform === "win32"
    ? "使用正斜杠 / 表示路径（例如 F:/project/test.py），避免反斜杠"
    : "使用 / 表示路径";

  let shellHint;
  if (platform === "win32") {
    shellHint = "默认 shell 是 PowerShell 或 CMD。命令需要兼容，例如 dir 代替 ls，但 ls 在 PowerShell 里也能用。";
  } else {
    shellHint = "默认 shell 是 bash 或 sh。";
  }

  return {
    platformName, platform, arch, release, cwd, home, tmpdir,
    nodeVersion,
    date: date.toISOString(),
    dateLocal: date.toString(),
    sep, pathStyle, shellHint,
  };
}

// ==========================================
// 生成系统信息段落
// ==========================================
function buildSystemSection(info) {
  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【运行环境信息】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- 操作系统: ${info.platformName} (${info.platform} ${info.release})
- CPU 架构: ${info.arch}
- Node.js 版本: ${info.nodeVersion}
- 当前工作目录: ${info.cwd}
- 用户主目录: ${info.home}
- 临时目录: ${info.tmpdir}
- 路径分隔符: ${JSON.stringify(info.sep)}
- 当前时间: ${info.dateLocal}
- ${info.pathStyle}
- ${info.shellHint}

【路径书写规范】
1. 所有路径必须用正斜杠 /，不要用反斜杠 \\。
   - ✅ 正确: F:/project/ai-bridge/sort.py
   - ✅ 正确: ./sort.py
   - ✅ 正确: sort.py
   - ❌ 错误: F:\\project\\ai-bridge\\sort.py
2. 相对路径是相对于"当前工作目录"解析的。
3. 如果用户没指定路径，默认在当前工作目录下创建文件。
4. 路径中如果有中文或空格，正常书写即可，不需要转义。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【编译运行规范 — Windows 必须遵守】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ Windows 中文环境默认使用 GBK 编码，而写出的源文件是 UTF-8。
   直接编译运行会报"编码 GBK 的不可映射字符"错误。
   编译和运行任何语言时，必须显式指定 UTF-8 编码。

【Java】
- 编译: javac -encoding UTF-8 FileName.java
- 运行: java -Dfile.encoding=UTF-8 ClassName
- 完整命令（Windows）:
  cd /d <目录> && javac -encoding UTF-8 Hello.java && java -Dfile.encoding=UTF-8 Hello

【Python】
- Windows 上 Python 默认也可能用 GBK。运行方式：
  set PYTHONIOENCODING=utf-8 && python hello.py
  或者直接在源码开头加: # -*- coding: utf-8 -*-
  更推荐: 在 Python 3 里加 sys.stdout.reconfigure(encoding='utf-8')

【Node.js】
- 一般不需要额外指定。
- 若输出中文乱码: chcp 65001 && node app.js

【C / C++】
- 编译: gcc -finput-charset=UTF-8 -fexec-charset=UTF-8 hello.c -o hello.exe
- 或 g++ -finput-charset=UTF-8 -fexec-charset=UTF-8 hello.cpp -o hello.exe

【通用规则】
1. 只要生成包含中文的源文件，编译/运行时一律加 UTF-8 参数。
2. Windows 命令用 \`&&\` 连接；路径用正斜杠 /。
3. exec_shell 在 Windows 上使用 cmd，可以直接用 \`cd /d F:/path && ...\`。
4. 一次性给出完整的编译+运行命令，不要分开调用。
5. 如果第一次编译因为编码失败，直接加上 -encoding UTF-8 重试，不要换其他方案。`;
}

// ==========================================
// 构建 System Prompt
// ==========================================
function buildSystemPrompt(workdir) {
  const info = collectSystemInfo(workdir);
  const section = buildSystemSection(info);

  return `你是一个决策引擎，不直接执行任何操作。

你的唯一工作：每次回复只输出下面描述的内容。

外部程序会读取你的输出，执行对应动作，然后把结果发回给你。你不需要自己去执行，也不需要说"我做不到"。

${section}

${TOOL_DESCRIPTIONS}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【输出格式 — 最重要，必须照抄】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

你所有的输出都必须用 markdown 代码块包裹，语言标记写 agent：

\`\`\`agent
你的全部内容放在这里
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【三种回复形式】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【A. 写文件】—— write_file

代码块内部结构：第一行 JSON，之后跟 CONTENT 块。

\`\`\`agent
{"thought":"简短思考","action":"write_file","action_input":{"path":"文件路径"}}
<<<CONTENT>>>
文件原始内容
<<<END_CONTENT>>>
\`\`\`

完整示例：

\`\`\`agent
{"thought":"写入一个 Python 打招呼程序","action":"write_file","action_input":{"path":"hello.py"}}
<<<CONTENT>>>
def hello(name):
    print(f"Hello, {name}!")

if __name__ == '__main__':
    hello("World")
<<<END_CONTENT>>>
\`\`\`

【B. 调用其他工具】—— read_file、list_dir、exec_shell、fetch_url

\`\`\`agent
{"thought":"简短思考","action":"工具名","action_input":{参数}}
\`\`\`

例如：

\`\`\`agent
{"thought":"查看当前目录","action":"list_dir","action_input":{"path":"."}}
\`\`\`

【C. 任务完成】

\`\`\`agent
{"thought":"简短思考","final_answer":"给用户的最终答案"}
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【为什么必须用代码块包裹？】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

网页渲染会把普通文本的行首空格吃掉，Python 代码会失去缩进。
用 \`\`\`agent 代码块包裹后，内容会被渲染成 <pre> 标签，所有缩进、
换行、特殊字符原样保留。

所以：无论回复多短，都必须用 \`\`\`agent 包裹。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【写文件的硬性规则】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. action_input 里只写 path，绝对不要写 content 字段。
2. 文件内容放在 <<<CONTENT>>> 和 <<<END_CONTENT>>> 之间。
3. CONTENT 块里的内容直接写原始文本（保留缩进），不要再套代码块。
4. 内容里可以有：双引号、单引号、反引号、中文、emoji，都没问题。
5. 内容里不要包含 <<<CONTENT>>> 或 <<<END_CONTENT>>> 这两个字符串。
6. <<<CONTENT>>> 和 <<<END_CONTENT>>> 各占一行，前后不要加其它字符。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【JSON 部分的转义规则】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

JSON 部分只是结构数据（thought、action、path），一般不含特殊字符。
如果确实需要：
1. 双引号转义为 \\"
2. 换行写成 \\n
3. 反斜杠写成 \\\\
4. 路径统一用正斜杠（见运行环境信息里的路径规范）

【硬性规则】
1. 不要输出"我不能"、"我无法"、"请提供"。
2. action_input 必须是合法 JSON 对象。
3. 任务完成后才使用 final_answer。
4. 不要输出推理过程，推理放进 thought 字段。
5. 每次回复必须且只能有一个 \`\`\`agent 代码块。

现在开始，等待用户任务。`;
}

// ==========================================
// 进度输出工具
// ==========================================
function logStepHeader(step, maxSteps) {
  console.log("");
  console.log(`┌───────────────────────────────────────────────────`);
  console.log(`│ 📍 步骤 ${step} / ${maxSteps}`);
  console.log(`└───────────────────────────────────────────────────`);
}

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

// ==========================================
// 工具输入摘要
// ==========================================
function summarizeToolInput(toolName, input) {
  if (!input) return "";
  if (toolName === "write_file") {
    const size = input.content ? `(${input.content.length} 字符)` : "";
    return `${input.path || "?"} ${size}`;
  }
  if (toolName === "read_file" || toolName === "list_dir" ||
      toolName === "file_exists" || toolName === "file_stat" ||
      toolName === "read_lines" || toolName === "head" || toolName === "tail" ||
      toolName === "mkdir" || toolName === "delete_file" || toolName === "delete_dir") {
    return `${input.path || "?"}`;
  }
  if (toolName === "exec_shell") {
    const cmd = input.cmd || "";
    return `"${cmd.slice(0, 60)}${cmd.length > 60 ? "..." : ""}"`;
  }
  if (toolName === "fetch_url") {
    return `${input.url || "?"}`;
  }
  if (toolName === "search_files" || toolName === "grep") {
    return `"${input.pattern || ""}"`;
  }
  if (toolName === "move_file" || toolName === "copy_file") {
    return `${input.from || "?"} → ${input.to || "?"}`;
  }
  const keys = Object.keys(input);
  return keys.length ? `{${keys.join(",")}}` : "";
}

// ==========================================
// 主流程
// ==========================================
export async function runAgent(task, {
  site = "chatgpt",
  maxSteps = 100,
  sessionId = "agent-" + Date.now(),
  signal,
  quiet = false,
  onEvent,
  workdir,
} = {}) {

  const emit = typeof onEvent === "function" ? onEvent : (() => {});
  const startedAt = Date.now();

  const checkAbort = () => {
    if (signal?.aborted) {
      const err = new Error("任务已取消");
      err.name = "AbortError";
      throw err;
    }
  };

  const chatOpts = { site, sessionId, signal };

  const logIcon = (icon, text) => {
    if (!quiet) console.log(`  ${icon} ${text}`);
    emit({ type: "log", icon, text });
  };

  const logHeader = (step, maxSteps) => {
    if (!quiet) logStepHeader(step, maxSteps);
    emit({ type: "step-start", step, maxSteps });
  };

  // ==========================================
  // 1) workdir 处理
  // ==========================================
  const originalCwd = process.cwd();
  const targetWorkdir = workdir ? path.resolve(workdir) : originalCwd;
  let didChdir = false;

  if (targetWorkdir !== originalCwd) {
    try {
      const stat = await fs.stat(targetWorkdir);
      if (!stat.isDirectory()) {
        throw new Error("不是目录");
      }
      process.chdir(targetWorkdir);
      didChdir = true;
      if (!quiet) {
        console.log(`📂 切换工作目录: ${originalCwd} → ${targetWorkdir}`);
      }
      emit({ type: "workdir", from: originalCwd, to: targetWorkdir });
    } catch (err) {
      const result = {
        ok: false,
        reason: "workdir_invalid",
        message: `工作目录无效: ${targetWorkdir} (${err.message})`,
      };
      if (!quiet) {
        console.error(`❌ 工作目录无效: ${targetWorkdir} — ${err.message}`);
      }
      log.audit("TASK_END", {
        sessionId, ok: false, reason: "workdir_invalid",
        message: result.message,
        elapsed: Date.now() - startedAt,
      });
      emit({ type: "done", ...result });
      return result;
    }
  }

  log.audit("TASK_START", {
    sessionId, site,
    workdir: targetWorkdir,
    taskHead: task.slice(0, 100),
    taskLen: task.length,
  });

  // ==========================================
  // 2) 主流程
  // ==========================================
  try {
    const SYSTEM_PROMPT = buildSystemPrompt(process.cwd());

    if (!quiet) {
      const info = collectSystemInfo(process.cwd());
      console.log("");
      console.log("╔═══════════════════════════════════════════════════╗");
      console.log("║              🤖  AI Agent 启动                    ║");
      console.log("╚═══════════════════════════════════════════════════╝");
      console.log("");
      console.log(`📋 任务: ${task}`);
      console.log(`🔖 sessionId: ${sessionId}`);
      console.log(`🖥️  环境: ${info.platformName} (${info.platform}) / ${info.arch}`);
      console.log(`📁 工作目录: ${process.cwd()}`);
      console.log(`⏰ 开始时间: ${new Date().toLocaleString()}`);
      console.log("");
    }

    emit({ type: "started", task, sessionId, site, startedAt, workdir: process.cwd() });

    checkAbort();

    // ==========================================
    // ★ 方案 A + B：第 1 步的 prompt 处理
    // ==========================================
    const needFullPrompt = !PROMPT_SENT.has(sessionId);

    if (!quiet) {
      console.log(`[agent] prompt 模式: ${needFullPrompt ? "完整（首次）" : "精简（复用）"}`);
    }

    const firstPrompt = needFullPrompt
      ? `${SYSTEM_PROMPT}

用户任务：${task}

请直接输出第一个决策。`
      : `用户任务：${task}

请直接输出第一个决策。（规则同前，只输出 \`\`\`agent 代码块）`;

    let reply = await chat(firstPrompt, chatOpts);
    checkAbort();

    // 调用成功后再记录，避免失败时丢失缓存
    PROMPT_SENT.add(sessionId);

    for (let step = 0; step < maxSteps; step++) {
      logHeader(step + 1, maxSteps);
      logIcon("🧠", "思考中...");
      emit({ type: "llm-reply", step: step + 1, raw: reply });

      let parsed = parseAgentOutput(reply);

      if (!parsed) {
        console.log("═══════ LLM 原始输出reply═══════");
        console.log(reply);
        console.log("═══════════════════════════════════════");
        log.error("JSON 解析失败,reply=", reply);
        logIcon("⚠️", "JSON 解析失败，让 LLM 重做...");

        reply = await chat(
          `你刚才的输出无法解析。请重新输出，严格遵守：
1. 整段内容必须放在 \`\`\`agent ... \`\`\` 代码块里。
2. 代码块内第一行是 JSON：{"thought":"...","action":"工具名","action_input":{...}}
3. 如果 action 是 write_file，JSON 之后要用 <<<CONTENT>>> ... <<<END_CONTENT>>> 包裹文件内容。
4. CONTENT 块里直接写原始内容，不要套代码块，不要转义。
5. 路径用正斜杠 /。

你刚才的输出是：
${reply.slice(0, 800)}`,
          chatOpts
        );
        checkAbort();
        logIcon("🔁", `LLM 重试: ${reply}`);
        parsed = parseAgentOutput(reply);
      }

      if (!parsed) {
        logIcon("❌", "重试后仍解析失败");
        if (!quiet) {
          console.log("");
          console.log("╔═══════════════════════════════════════════════════╗");
          console.log("║  ❌  任务失败（解析错误）                          ║");
          console.log("╚═══════════════════════════════════════════════════╝");
        }
        const result = { ok: false, reason: "parse_error", raw: reply };
        log.audit("TASK_END", {
          sessionId, ok: false, reason: "parse_error",
          elapsed: Date.now() - startedAt,
        });
        emit({ type: "done", ...result });
        return result;
      }

      if (parsed.final_answer) {
        const elapsed = Date.now() - startedAt;
        logIcon("🎉", `任务完成`);
        if (!quiet) {
          console.log("");
          console.log("╔═══════════════════════════════════════════════════╗");
          console.log("║  ✅  任务完成                                     ║");
          console.log("╚═══════════════════════════════════════════════════╝");
          console.log("");
          console.log("📝 最终答案:");
          console.log("─────────────────────────────────────────────────");
          console.log(parsed.final_answer);
          console.log("─────────────────────────────────────────────────");
          console.log("");
          console.log(`⏱️  总耗时: ${formatElapsed(elapsed)}`);
          console.log(`📍 执行步数: ${step + 1} / ${maxSteps}`);
          console.log("");
        }
        const result = { ok: true, answer: parsed.final_answer, elapsed, steps: step + 1 };
        log.audit("TASK_END", {
          sessionId, ok: true, elapsed, steps: step + 1,
          answer: String(parsed.final_answer).slice(0, 200),
        });
        emit({ type: "done", ...result });
        return result;
      }

      const toolName = parsed.action;
      const toolInput = parsed.action_input || {};

      if (!tools[toolName]) {
        logIcon("⚠️", `未知工具: ${toolName}`);
        reply = await chat(
          `工具 "${toolName}" 不存在。可用工具只有：${Object.keys(tools).join(", ")}。请重新决策，只输出 \`\`\`agent 包裹的 JSON。写文件必须用 write_file。`,
          chatOpts
        );
        checkAbort();
        continue;
      }

      const inputSummary = summarizeToolInput(toolName, toolInput);
      logIcon("🔧", `调用工具: ${toolName} ${inputSummary}`);
      if (parsed.thought) {
        logIcon("💭", `思考: ${parsed.thought}`);
      }
      emit({
        type: "tool-call",
        step: step + 1,
        toolName,
        input: toolInput,
        thought: parsed.thought || "",
      });
      log.audit("TOOL_CALL", {
        step: step + 1, tool: toolName, args: inputSummary,
      });

      const toolStartedAt = Date.now();
      let observation;
      let toolSuccess = true;
      try {
        observation = await tools[toolName](toolInput);
      } catch (err) {
        observation = `工具执行失败: ${err.message}`;
        toolSuccess = false;
      }
      const toolElapsed = Date.now() - toolStartedAt;
      const truncated = String(observation).slice(0, 3000);

      log.audit("TOOL_RESULT", {
        step: step + 1, tool: toolName,
        ok: toolSuccess, elapsed: toolElapsed,
        head: truncated.slice(0, 200),
      });

      if (toolSuccess) {
        logIcon("✅", `完成 (${formatElapsed(toolElapsed)}): ${truncated.slice(0, 100)}${truncated.length > 100 ? "..." : ""}`);
      } else {
        logIcon("❌", `失败 (${formatElapsed(toolElapsed)}): ${truncated.slice(0, 100)}`);
      }
      emit({
        type: "tool-result",
        step: step + 1, toolName,
        ok: toolSuccess, elapsed: toolElapsed,
        observation: truncated,
      });

      checkAbort();

      if (
        toolName === "write_file" &&
        /缺少 content|必须用 <<<CONTENT>>>/i.test(observation)
      ) {
        logIcon("🔁", "写文件缺少 CONTENT 块，让 LLM 重做");
        reply = await chat(
          `写入失败：${observation}

请重新输出，格式必须是：

\`\`\`agent
{"thought":"...","action":"write_file","action_input":{"path":"..."}}
<<<CONTENT>>>
原始文件内容（保留缩进）
<<<END_CONTENT>>>
\`\`\`

注意：
1. 整段内容必须包在 \`\`\`agent 代码块里。
2. action_input 里只写 path，不要写 content。
3. 文件内容放在 <<<CONTENT>>> ... <<<END_CONTENT>>> 之间，不要转义。
4. 路径用正斜杠 /。`,
          chatOpts
        );
        checkAbort();
        continue;
      }

      logIcon("➡️", "继续下一步...");
      reply = await chat(
        `工具 ${toolName} 返回：\n\`\`\`\n${truncated}\n\`\`\`\n\n请继续思考下一步。记住：整段回复必须包在 \`\`\`agent 代码块里，路径用正斜杠 /。`,
        chatOpts
      );
      checkAbort();
    }

    // 超过最大步数
    console.error(`[agent] ❌ 超过最大步数 ${maxSteps}`);
    const result = { ok: false, reason: "max_steps" };
    log.audit("TASK_END", {
      sessionId, ok: false, reason: "max_steps",
      elapsed: Date.now() - startedAt,
    });
    emit({ type: "done", ...result });
    return result;
  } finally {
    if (didChdir) {
      try {
        process.chdir(originalCwd);
        if (!quiet) console.log(`📂 已恢复工作目录: ${originalCwd}`);
      } catch (e) {
        console.error(`恢复工作目录失败: ${e.message}`);
      }
    }
  }
}

// ==========================================
// JSON 解析
// ==========================================
export function parseAgentOutput(text) {
  if (!text) return null;

  let body = text;
  const outer = text.match(/^\s*```(?:agent|json|plaintext|text|markdown)?\s*\n([\s\S]*?)\n```\s*$/);
  if (outer) {
    body = outer[1];
  }

  const { rawContent, cleanedText } = extractContentBlock(body);
  const parsed = parseJSONOnly(cleanedText);
  if (!parsed) return null;

  if (parsed.action === "write_file" && rawContent !== null) {
    if (!parsed.action_input) parsed.action_input = {};
    parsed.action_input.content = rawContent;
  }

  return parsed;
}

function extractContentBlock(text) {
  const m = text.match(/<<<CONTENT>>>([\s\S]*?)<<<END_CONTENT>>>/);
  if (!m) return { rawContent: null, cleanedText: text };

  let content = m[1];

  if (content.startsWith("\r\n")) content = content.slice(2);
  else if (content.startsWith("\n")) content = content.slice(1);

  if (content.endsWith("\r\n")) content = content.slice(0, -2);
  else if (content.endsWith("\n")) content = content.slice(0, -1);

  content = stripMarkdownCodeFence(content);

  const cleanedText = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  return { rawContent: content, cleanedText };
}

function stripMarkdownCodeFence(content) {
  const m = content.match(/^\s*(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/);
  if (m) return m[2];

  const LANG_RE = /^(python|py|javascript|js|typescript|ts|java|c\+\+|cpp|c#|csharp|go|golang|rust|ruby|php|swift|kotlin|bash|sh|shell|sql|html|css|json|xml|yaml|yml|markdown|md|text|plaintext|plain|c|cpp|agent)$/i;
  const lines = content.split("\n");
  if (lines.length >= 2 && LANG_RE.test(lines[0].trim())) {
    return lines.slice(1).join("\n");
  }

  return content;
}

function parseJSONOnly(text) {
  if (!text) return null;

  const codeMatches = [...text.matchAll(/```(?:json|agent)?\s*([\s\S]*?)```/g)];
  for (let i = codeMatches.length - 1; i >= 0; i--) {
    const obj = tryParseJSON(codeMatches[i][1].trim());
    if (obj && isDecision(obj)) return obj;
  }

  const found = extractLastJSON(text);
  if (found) return found;

  return null;
}

function isDecision(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.action === "string") return true;
  if (typeof obj.final_answer === "string") return true;
  return false;
}

function extractLastJSON(text) {
  for (let end = text.length - 1; end >= 0; end--) {
    if (text[end] !== "}") continue;

    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") {
        depth--;
        if (depth === 0) { start = i; break; }
      }
    }
    if (start < 0) continue;

    const candidate = text.slice(start, end + 1);
    const obj = tryParseJSON(candidate);
    if (obj && isDecision(obj)) return obj;
  }
  return null;
}

function tryParseJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch {}
  try {
    const fixed = str.replace(/\\(?![\\"/bfnrtu])/g, "\\\\");
    return JSON.parse(fixed);
  } catch {}
  return null;
}