let ws = null;
let reconnectTimer = null;

const LOCAL_WS = "ws://127.0.0.1:8765/ws?token=LOCAL_TOKEN";

const SITE_URLS = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/app",
  kimi: "https://www.kimi.com/",
  deepseek: "https://chat.deepseek.com/",
  wenxin: "https://chat.baidu.com/",      // ★ 加这行
};

function connect() {
  ws = new WebSocket(LOCAL_WS);
  ws.onopen = () => console.log("[AI-BRIDGE] Local WS connected");

  ws.onmessage = async (event) => {
	  const msg = JSON.parse(event.data);

	  if (msg.type === "ping") return;

	  // ★ 新增：处理 abort
	  if (msg.type === "command" && msg.action === "abort") {
		console.log("[AI-BRIDGE] 收到 abort, requestId:", msg.requestId);
		// 通知所有相关 tab 停止
		try {
		  const tabs = await chrome.tabs.query({});
		  for (const tab of tabs) {
			try {
			  await chrome.tabs.sendMessage(tab.id, {
				type: "command",
				action: "abort",
				requestId: msg.requestId,
			  });
			} catch {}
		  }
		} catch {}
		return;
	  }

	  if (msg.type !== "command") return;

    console.log("[AI-BRIDGE] 命令:", msg.sessionId, "url:", msg.url, "newChat:", msg.newChat);

    try {
      // 1. 找或创建该站点的唯一 tab
      const tabId = await getOrCreateSiteTab(msg.site);

      // 2. 如果需要切到某个会话 URL
      if (msg.url) {
        const tab = await chrome.tabs.get(tabId);
        const cur = tab.url || "";
        // 只有 URL 明显不同才导航
        if (!cur.startsWith(msg.url)) {
          console.log("[AI-BRIDGE] 导航到", msg.url);
          await chrome.tabs.update(tabId, { url: msg.url });
          await waitForTabComplete(tabId, 30000);
          await sleep(1500);
        }
      }

      // 3. 发命令给 content.js
      await sendMessageWithRetry(tabId, { ...msg, tabId });

    } catch (err) {
      console.error("[AI-BRIDGE] 错误:", err);
      sendToLocal({
        type: "event",
        requestId: msg.requestId,
        event: "error",
        message: err.message,
      });
    }
  };

  ws.onclose = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

function sendToLocal(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// 每个站点只保留一个 tab
async function getOrCreateSiteTab(site) {
  const urlPattern = SITE_URLS[site] + "*";
  const tabs = await chrome.tabs.query({ url: urlPattern });
  if (tabs.length > 0) {
    // 优先非激活的，避免打断用户
    return tabs[0].id;
  }

  console.log("[AI-BRIDGE] 新建站点 tab:", site);
  const tab = await chrome.tabs.create({ url: SITE_URLS[site], active: false });
  await waitForTabComplete(tab.id, 30000);
  await sleep(1500);
  return tab.id;
}

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return resolve();
        if (tab.status === "complete") return resolve();
        if (Date.now() - start > timeout) return resolve();
        setTimeout(check, 400);
      });
    };
    check();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendMessageWithRetry(tabId, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, msg);
      console.log("[AI-BRIDGE] 命令已送达 tab", tabId);
      return;
    } catch (err) {
      console.log(`[AI-BRIDGE] sendMessage 失败 (${i + 1}/${retries}):`, err.message);

      // 第一次失败：reload 让 content.js 重新注入
      if (i === 0) {
        console.log("[AI-BRIDGE] reload tab", tabId);
        try { await chrome.tabs.reload(tabId); } catch {}
        await waitForTabComplete(tabId, 30000);
        await sleep(2500);
      } else {
        await sleep(1500);
      }

      if (i === retries - 1) throw err;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.source === "AI_BRIDGE") {
    sendToLocal({ ...msg, tabId: sender.tab?.id });
  }
});

connect();
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
}, 20000);