// ==========================================
// agent/llm.js
// ==========================================
const BRIDGE = "http://127.0.0.1:8787/v1/chat/completions";

export async function chat(content, {
  site = "chatgpt",
  sessionId = "agent",
  signal,               // ★ 支持取消
} = {}) {
  const res = await fetch(BRIDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "web-ai",
      site,
      session_id: sessionId,
      stream: true,
      messages: [{ role: "user", content }],
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`bridge ${res.status}: ${errText.slice(0, 200)}`);
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
      const j = JSON.parse(data);
      const d = j.choices?.[0]?.delta?.content;
      if (d) out += d;
    } catch {}
  }
  return out;
}