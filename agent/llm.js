// agent/llm.js
const BRIDGE = "http://127.0.0.1:8787/v1/chat/completions";

/**
 * 发一条消息给网页 AI，返回完整文本
 * @param {string} content 消息内容
 * @param {object} opts { site, sessionId }
 */
export async function chat(content, { site = "chatgpt", sessionId = "agent" } = {}) {
  const res = await fetch(BRIDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "web-ai",
      site,
      session_id: sessionId,
      stream: true,          // bridge 目前只支持流式，我们在客户端拼完整
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`bridge 返回 ${res.status}: ${err}`);
  }

  const raw = await res.text();
  return parseSSE(raw);
}

function parseSSE(raw) {
  let out = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) out += delta;
    } catch {}
  }
  return out;
}