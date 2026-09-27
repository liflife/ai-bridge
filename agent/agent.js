// ==========================================
// agent/agent.js
// ==========================================
import { chat } from "./llm.js";
import { tools, TOOL_DESCRIPTIONS } from "./tools.js";

// ==========================================
// System Prompt
// ==========================================
const SYSTEM_PROMPT = `你是一个决策引擎，不直接执行任何操作。

你的唯一工作：每次回复只输出下面描述的内容。

外部程序会读取你的输出，执行对应动作，然后把结果发回给你。你不需要自己去执行，也不需要说"我做不到"。

${TOOL_DESCRIPTIONS}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【输出格式】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

你有三种回复形式：

【A. 写文件】—— 使用 write_file

输出分两部分：

第一部分，一行 JSON（只放 path，不要写 content）：
{"thought":"简短思考","action":"write_file","action_input":{"path":"文件路径"}}

第二部分，紧跟在 JSON 后面，用 <<<CONTENT>>> 和 <<<END_CONTENT>>> 包裹文件内容。内容内部必须再用三反引号代码块包裹（用来保护缩进）：

<<<CONTENT>>>
\`\`\`text
文件的原始内容
\`\`\`
<<<END_CONTENT>>>

完整示例：

{"thought":"写入一个 Python 打招呼程序","action":"write_file","action_input":{"path":"hello.py"}}
<<<CONTENT>>>
\`\`\`python
def hello(name):
    print(f"Hello, {name}!")

if __name__ == '__main__':
    hello("World")
\`\`\`
<<<END_CONTENT>>>

⚠️ 为什么要用三反引号包裹？
- 网页渲染时会吃掉普通文本的行首空格，Python 代码会失去缩进。
- 用 \`\`\` 代码块包裹后，缩进会被完整保留。
- 语言标记可以写 python、text、javascript 等，也可以什么都不写。

【B. 调用其他工具】—— read_file、list_dir、exec_shell、fetch_url

只输出一行 JSON：
{"thought":"简短思考","action":"工具名","action_input":{参数}}

例如：
{"thought":"查看当前目录","action":"list_dir","action_input":{"path":"."}}

【C. 任务完成】

只输出一行 JSON：
{"thought":"简短思考","final_answer":"给用户的最终答案"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【写文件的硬性规则 — 最重要】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. content 不要做任何转义、编码、base64、\\n 处理。直接写原始内容即可。
2. 内容必须用三反引号代码块包裹，防止缩进被网页渲染吃掉。
3. 三反引号代码块整体再用 <<<CONTENT>>> 和 <<<END_CONTENT>>> 包裹。
4. <<<CONTENT>>> 单独占一行，<<<END_CONTENT>>> 也单独占一行。
5. 内容里可以有：双引号、单引号、换行、反斜杠、中文、emoji、任意字符。
6. JSON 部分不要有多余字符，不要用代码块包裹 JSON。
7. JSON 里的 action_input 只写 path，绝对不要写 content 字段。
8. 内容里不要包含 <<<CONTENT>>> 或 <<<END_CONTENT>>> 这两个字符串。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【JSON 部分的转义规则】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

JSON 部分只是结构数据（thought、action、path），一般不含特殊字符。
如果确实需要：
1. 双引号转义为 \\"
2. 换行写成 \\n
3. 反斜杠写成 \\\\
4. Windows 路径用正斜杠，例如 F:/project/test.py

【硬性规则】
1. 不要输出"我不能"、"我无法"、"请提供"。
2. action_input 必须是合法 JSON 对象。
3. 任务完成后才使用 final_answer。
4. 不要输出推理过程，推理放进 thought 字段。

现在开始，等待用户任务。`;

// ==========================================
// 主流程
// ==========================================
export async function runAgent(task, {
  site = "chatgpt",
  maxSteps = 10,
  sessionId = "agent-" + Date.now(),
} = {}) {

  console.log(`\n=== 任务: ${task} ===`);
  console.log(`[agent] sessionId = ${sessionId}\n`);

  // 第 1 步
  let reply = await chat(
    `${SYSTEM_PROMPT}

---

【重要提醒】本次会话规则如下，请忘掉之前对话里学到的任何工具定义：
1. 写文件用 write_file，action_input 只写 path。
2. 文件内容必须用 <<<CONTENT>>> ... <<<END_CONTENT>>> 包裹在 JSON 之后。
3. 包裹内的内容必须再套一层三反引号代码块（\`\`\`），用来保护缩进。
4. 不要做 base64、不要做转义，直接写原始内容。

用户任务：${task}

请直接输出第一个决策。不要解释，不要道歉，不要说你无法执行。`,
    { site, sessionId }
  );

  for (let step = 0; step < maxSteps; step++) {
    console.log(`\n--- Step ${step + 1} / ${maxSteps} ---`);
    console.log("[LLM]", reply.slice(0, 400) + (reply.length > 400 ? "..." : ""));

    let parsed = parseAgentOutput(reply);

    // 首次解析失败 → 让 LLM 重做
    if (!parsed) {
      console.warn("[agent] 首次解析失败，让 LLM 重做...");
      reply = await chat(
        `你刚才的输出无法解析。请重新输出，严格遵守：
1. 调用工具时，先输出一行 JSON：{"thought":"...","action":"工具名","action_input":{...}}
2. 如果 action 是 write_file，紧接着在 JSON 后面用 <<<CONTENT>>> ... <<<END_CONTENT>>> 包裹文件内容。
3. CONTENT 内部必须再套一层三反引号代码块（\`\`\`）。
4. JSON 部分不要用代码块包裹。

你刚才的输出是：
${reply.slice(0, 800)}`,
        { site, sessionId }
      );
      console.log("[LLM 重试]", reply.slice(0, 400));
      parsed = parseAgentOutput(reply);
    }

    if (!parsed) {
      console.error("[agent] 重试后仍解析失败，终止");
      return { ok: false, reason: "parse_error", raw: reply };
    }

    // 完成
    if (parsed.final_answer) {
      console.log("\n[agent] ✅ 最终答案:");
      console.log(parsed.final_answer);
      return { ok: true, answer: parsed.final_answer };
    }

    // 工具调用
    const toolName = parsed.action;
    const toolInput = parsed.action_input || {};

    if (!tools[toolName]) {
      console.warn(`[agent] 未知工具: ${toolName}`);
      reply = await chat(
        `工具 "${toolName}" 不存在。可用工具只有：${Object.keys(tools).join(", ")}。请重新决策，只输出 JSON。写文件必须用 write_file。`,
        { site, sessionId }
      );
      continue;
    }

    console.log(`[agent] 🔧 调用工具: ${toolName}(${JSON.stringify(toolInput).slice(0, 200)})`);

    let observation;
    try {
      observation = await tools[toolName](toolInput);
    } catch (err) {
      observation = `工具执行失败: ${err.message}`;
    }

    const truncated = String(observation).slice(0, 3000);
    console.log(`[agent] 📥 结果: ${truncated.slice(0, 200)}${truncated.length > 200 ? "..." : ""}`);

    // 写文件失败（忘了 CONTENT 块）→ 让 LLM 重做
    if (
      toolName === "write_file" &&
      /缺少 content|必须用 <<<CONTENT>>>/i.test(observation)
    ) {
      console.warn("[agent] 写文件缺少 CONTENT 块，让 LLM 重做");
      reply = await chat(
        `写入失败：${observation}

请重新输出，格式必须是：

第一行 JSON：
{"thought":"...","action":"write_file","action_input":{"path":"..."}}

紧接着（换行后）：
<<<CONTENT>>>
\`\`\`text
原始文件内容（保留缩进）
\`\`\`
<<<END_CONTENT>>>

注意：
1. action_input 里只写 path，不要写 content。
2. 内容必须用三反引号代码块包裹，防止缩进丢失。
3. <<<CONTENT>>> 和 <<<END_CONTENT>>> 各占一行。`,
        { site, sessionId }
      );
      continue;
    }

    // 下一步
    reply = await chat(
      `工具 ${toolName} 返回：\n\`\`\`\n${truncated}\n\`\`\`\n\n请继续思考下一步，只输出 JSON。写文件时记得用 <<<CONTENT>>> 包裹内容，并且内部再套一层三反引号代码块。`,
      { site, sessionId }
    );
  }

  console.error(`[agent] ❌ 超过最大步数 ${maxSteps}`);
  return { ok: false, reason: "max_steps" };
}

// ==========================================
// JSON 解析
// ==========================================

/**
 * 从 LLM 输出提取决策
 * 1. 如果有 <<<CONTENT>>> ... <<<END_CONTENT>>>，先提取出来
 * 2. JSON 从剩下的文本里解析
 * 3. 如果是 write_file 且有 content 块，把内容填进 action_input.content
 */
export function parseAgentOutput(text) {
  if (!text) return null;

  // 1. 提取 CONTENT 块
  const { rawContent, cleanedText } = extractContentBlock(text);

  // 2. 解析 JSON
  const parsed = parseJSONOnly(cleanedText);
  if (!parsed) return null;

  // 3. 如果是 write_file 且有 content 块，把内容填进去
  if (parsed.action === "write_file" && rawContent !== null) {
    if (!parsed.action_input) parsed.action_input = {};
    parsed.action_input.content = rawContent;
    console.log(`[agent] 提取到 CONTENT 块, 长度: ${rawContent.length}`);
  }

  return parsed;
}

/**
 * 从文本提取 <<<CONTENT>>> ... <<<END_CONTENT>>> 之间的内容
 * 返回 { rawContent, cleanedText }
 *   - rawContent: 内容块文本（已剥掉 markdown 代码块外壳）
 *   - cleanedText: 移除内容块后的剩余文本（用于 JSON 解析）
 */
function extractContentBlock(text) {
  const m = text.match(/<<<CONTENT>>>([\s\S]*?)<<<END_CONTENT>>>/);
  if (!m) return { rawContent: null, cleanedText: text };

  let content = m[1];

  // 去掉紧跟 <<<CONTENT>>> 的第一个换行
  if (content.startsWith("\r\n")) content = content.slice(2);
  else if (content.startsWith("\n")) content = content.slice(1);

  // 去掉 <<<END_CONTENT>>> 之前的一个换行
  if (content.endsWith("\r\n")) content = content.slice(0, -2);
  else if (content.endsWith("\n")) content = content.slice(0, -1);

  // ★ 剥掉 markdown 代码块外壳
  content = stripMarkdownCodeFence(content);

  const cleanedText = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  return { rawContent: content, cleanedText };
}

/**
 * 剥掉 ```lang ... ``` 外壳
 * 支持 ```python / ```text / ``` / ```` 等
 * 如果内容不是代码块，原样返回
 */
function stripMarkdownCodeFence(content) {
  // 匹配：可选前导空白 + 3个以上反引号 + 可选语言 + 换行 ... 换行 + 相同数量反引号 + 可选尾部空白
  const m = content.match(/^\s*(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/);
  if (m) {
    console.log("[agent] 剥掉 markdown 代码块外壳, 反引号数:", m[1].length);
    return m[2];
  }
  return content;
}

/**
 * 只解析 JSON（不再处理 CONTENT 块）
 */
function parseJSONOnly(text) {
  if (!text) return null;

  // 1. markdown 代码块（从后往前）
  const codeMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = codeMatches.length - 1; i >= 0; i--) {
    const obj = tryParseJSON(codeMatches[i][1].trim());
    if (obj && isDecision(obj)) {
      console.log("[agent] 从代码块提取到 JSON");
      return obj;
    }
  }

  // 2. 从末尾往前找平衡的 JSON
  const found = extractLastJSON(text);
  if (found) return found;

  return null;
}

/**
 * 判断是不是合法决策
 */
function isDecision(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.action === "string") return true;
  if (typeof obj.final_answer === "string") return true;
  return false;
}

/**
 * 从文本末尾往前扫描所有平衡的 {...}
 */
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
      console.log("[agent] 从末尾提取到 JSON, 长度:", candidate.length);
      return obj;
    }
  }
  return null;
}

/**
 * 加强版 JSON 解析
 */
function tryParseJSON(str) {
  if (!str) return null;

  // 1. 直接试
  try { return JSON.parse(str); } catch {}

  // 2. 修复非法转义（如 F:\project 的 \p）
  try {
    const fixed = str.replace(/\\(?![\\"/bfnrtu])/g, "\\\\");
    return JSON.parse(fixed);
  } catch {}

  return null;
}