// ==========================================
// agent/agent.js
// ==========================================
import { chat } from "./llm.js";
import { tools, TOOL_DESCRIPTIONS } from "./tools.js";
import os from "os";
import path from "path";

// ==========================================
// 收集系统信息
// ==========================================
function collectSystemInfo() {
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  const cwd = process.cwd();
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
    platformName,
    platform,
    arch,
    release,
    cwd,
    home,
    tmpdir,
    nodeVersion,
    date: date.toISOString(),
    dateLocal: date.toString(),
    sep,
    pathStyle,
    shellHint,
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
4. 路径中如果有中文或空格，正常书写即可，不需要转义。`;
}

// ==========================================
// 组装 System Prompt
// ==========================================
const SYSTEM_INFO = collectSystemInfo();
const SYSTEM_SECTION = buildSystemSection(SYSTEM_INFO);

const SYSTEM_PROMPT = `你是一个决策引擎，不直接执行任何操作。

你的唯一工作：每次回复只输出下面描述的内容。

外部程序会读取你的输出，执行对应动作，然后把结果发回给你。你不需要自己去执行，也不需要说"我做不到"。

${SYSTEM_SECTION}

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

// ==========================================
// 进度输出工具
// ==========================================
function logStepHeader(step, maxSteps) {
  console.log("");
  console.log(`┌───────────────────────────────────────────────────`);
  console.log(`│ 📍 步骤 ${step} / ${maxSteps}`);
  console.log(`└───────────────────────────────────────────────────`);
}

function logSubIcon(icon, text) {
  console.log(`  ${icon} ${text}`);
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
  if (toolName === "read_file" || toolName === "list_dir") {
    return `${input.path || "?"}`;
  }
  if (toolName === "exec_shell") {
    const cmd = input.cmd || "";
    return `"${cmd.slice(0, 60)}${cmd.length > 60 ? "..." : ""}"`;
  }
  if (toolName === "fetch_url") {
    return `${input.url || "?"}`;
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
} = {}) {

  const startedAt = Date.now();

  const checkAbort = () => {
    if (signal?.aborted) {
      const err = new Error("任务已取消");
      err.name = "AbortError";
      throw err;
    }
  };

  // ★ 所有 chat 调用共用这个 opts，带上 signal
  const chatOpts = { site, sessionId, signal };

  if (!quiet) {
    console.log("");
    console.log("╔═══════════════════════════════════════════════════╗");
    console.log("║              🤖  AI Agent 启动                    ║");
    console.log("╚═══════════════════════════════════════════════════╝");
    console.log("");
    console.log(`📋 任务: ${task}`);
    console.log(`🔖 sessionId: ${sessionId}`);
    console.log(`🖥️  环境: ${SYSTEM_INFO.platformName} (${SYSTEM_INFO.platform}) / ${SYSTEM_INFO.arch}`);
    console.log(`📁 工作目录: ${SYSTEM_INFO.cwd}`);
    console.log(`⏰ 开始时间: ${new Date().toLocaleString()}`);
    console.log("");
  }

  checkAbort();

  // 第 1 步
  let reply = await chat(
    `${SYSTEM_PROMPT}

---

【重要提醒】本次会话规则如下，请忘掉之前对话里学到的任何工具定义：
1. 每次回复都要用 \`\`\`agent 代码块包裹整段内容。
2. 写文件用 write_file，action_input 只写 path。
3. 文件内容用 <<<CONTENT>>> ... <<<END_CONTENT>>> 包裹在 JSON 之后。
4. CONTENT 块里直接写原始内容（保留缩进），不要再套代码块。
5. 路径统一用正斜杠（/），不要用反斜杠。
6. 不要做 base64、不要做转义。

用户任务：${task}

请直接输出第一个决策。不要解释，不要道歉，不要说你无法执行。`,
    chatOpts
  );
  checkAbort();

  for (let step = 0; step < maxSteps; step++) {
    logStepHeader(step + 1, maxSteps);
    logSubIcon("🧠", "思考中...");
    
    let parsed = parseAgentOutput(reply);

    if (!parsed) {
      logSubIcon("💬", `JSON 解析失败,文本: ${reply}`);
	  logSubIcon("💬", "----------------------------");
      logSubIcon("⚠️", "JSON 解析失败，让 LLM 重做...");
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
      logSubIcon("🔁", `LLM 重试: ${reply.slice(0, 200)}${reply.length > 200 ? "..." : ""}`);
      parsed = parseAgentOutput(reply);
    }

    if (!parsed) {
      logSubIcon("❌", "重试后仍解析失败");
      if (!quiet) {
        console.log("");
        console.log("╔═══════════════════════════════════════════════════╗");
        console.log("║  ❌  任务失败（解析错误）                          ║");
        console.log("╚═══════════════════════════════════════════════════╝");
      }
      return { ok: false, reason: "parse_error", raw: reply };
    }

    if (parsed.final_answer) {
      const elapsed = Date.now() - startedAt;
      logSubIcon("🎉", `任务完成`);
      if (!quiet) {
        console.log("");
        console.log("╔═══════════════════════════════════════════════════╗");
        console.log("║  ✅  任务完成                                     ║");
        console.log("╚═══════════════════════════════════════════════════╝");
      }
      console.log("");
      console.log("📝 最终答案:");
      console.log("─────────────────────────────────────────────────");
      console.log(parsed.final_answer);
      console.log("─────────────────────────────────────────────────");
      if (!quiet) {
        console.log("");
        console.log(`⏱️  总耗时: ${formatElapsed(elapsed)}`);
        console.log(`📍 执行步数: ${step + 1} / ${maxSteps}`);
        console.log("");
      }
      return { ok: true, answer: parsed.final_answer };
    }

    const toolName = parsed.action;
    const toolInput = parsed.action_input || {};

    if (!tools[toolName]) {
      logSubIcon("⚠️", `未知工具: ${toolName}`);
      reply = await chat(
        `工具 "${toolName}" 不存在。可用工具只有：${Object.keys(tools).join(", ")}。请重新决策，只输出 \`\`\`agent 包裹的 JSON。写文件必须用 write_file。`,
        chatOpts
      );
      checkAbort();
      continue;
    }

    const inputSummary = summarizeToolInput(toolName, toolInput);
    logSubIcon("🔧", `调用工具: ${toolName} ${inputSummary}`);
    if (parsed.thought) {
      logSubIcon("💭", `思考: ${parsed.thought}`);
    }

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

    if (toolSuccess) {
      logSubIcon("✅", `完成 (${formatElapsed(toolElapsed)}): ${truncated.slice(0, 100)}${truncated.length > 100 ? "..." : ""}`);
    } else {
      logSubIcon("❌", `失败 (${formatElapsed(toolElapsed)}): ${truncated.slice(0, 100)}`);
    }

    checkAbort();

    if (
      toolName === "write_file" &&
      /缺少 content|必须用 <<<CONTENT>>>/i.test(observation)
    ) {
      logSubIcon("🔁", "写文件缺少 CONTENT 块，让 LLM 重做");
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

    logSubIcon("➡️", "继续下一步...");
    reply = await chat(
      `工具 ${toolName} 返回：\n\`\`\`\n${truncated}\n\`\`\`\n\n请继续思考下一步。记住：整段回复必须包在 \`\`\`agent 代码块里，路径用正斜杠 /。`,
      chatOpts
    );
    checkAbort();
  }

  console.error(`[agent] ❌ 超过最大步数 ${maxSteps}`);
  return { ok: false, reason: "max_steps" };
}

// ==========================================
// JSON 解析
// ==========================================

/**
 * 从 LLM 输出提取决策
 */
export function parseAgentOutput(text) {
  if (!text) return null;

  // Step 0: 剥掉最外层代码块
  let body = text;
  const outer = text.match(/^\s*```(?:agent|json|plaintext|text|markdown)?\s*\n([\s\S]*?)\n```\s*$/);
  if (outer) {
    body = outer[1];
  }

  // Step 1: 提取 CONTENT 块
  const { rawContent, cleanedText } = extractContentBlock(body);

  // Step 2: 解析 JSON
  const parsed = parseJSONOnly(cleanedText);
  if (!parsed) return null;

  // Step 3: 填充 content
  if (parsed.action === "write_file" && rawContent !== null) {
    if (!parsed.action_input) parsed.action_input = {};
    parsed.action_input.content = rawContent;
  }

  return parsed;
}

/**
 * 提取 <<<CONTENT>>> ... <<<END_CONTENT>>> 之间的内容
 */
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

/**
 * 剥掉 ```lang ... ``` 外壳
 */
function stripMarkdownCodeFence(content) {
  // 情况1: 标准代码块
  const m = content.match(/^\s*(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/);
  if (m) {
    return m[2];
  }

  // 情况2: 首行是纯语言名
  const LANG_RE = /^(python|py|javascript|js|typescript|ts|java|c\+\+|cpp|c#|csharp|go|golang|rust|ruby|php|swift|kotlin|bash|sh|shell|sql|html|css|json|xml|yaml|yml|markdown|md|text|plaintext|plain|c|cpp|agent)$/i;
  const lines = content.split("\n");
  if (lines.length >= 2 && LANG_RE.test(lines[0].trim())) {
    return lines.slice(1).join("\n");
  }

  return content;
}

/**
 * 只解析 JSON
 */
function parseJSONOnly(text) {
  if (!text) return null;

  const codeMatches = [...text.matchAll(/```(?:json|agent)?\s*([\s\S]*?)```/g)];
  for (let i = codeMatches.length - 1; i >= 0; i--) {
    const obj = tryParseJSON(codeMatches[i][1].trim());
    if (obj && isDecision(obj)) {
      return obj;
    }
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
    if (obj && isDecision(obj)) {
      return obj;
    }
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