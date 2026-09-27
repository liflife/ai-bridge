let currentRequestId = null;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.source === "AI_BRIDGE_SET_REQUEST") {
    currentRequestId = event.data.requestId;
  }
});

const originalFetch = window.fetch;

window.fetch = async function (...args) {
  const response = await originalFetch.apply(this, args);

  const url = typeof args[0] === "string" ? args[0] : args[0]?.url;

  if (isAIStreamUrl(url)) {
    const clone = response.clone();

    readSSE(clone, (raw) => {
      window.postMessage({
        source: "AI_BRIDGE_NET",
        requestId: currentRequestId,
        url,
        raw
      }, "*");
    }).finally(() => {
      window.postMessage({
        source: "AI_BRIDGE_NET",
        requestId: currentRequestId,
        url,
        done: true
      }, "*");
    });
  }

  return response;
};

function isAIStreamUrl(url = "") {
  return (
    url.includes("/backend-api/conversation") ||
    url.includes("/completion") ||
    url.includes("/chat_conversations") ||
    url.includes("/stream")
  );
}

async function readSSE(response, onData) {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;

      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      onData(data);
    }
  }
}