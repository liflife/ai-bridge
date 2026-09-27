// ==========================================
// content.js
// 唯一职责：接收 background 命令，路由到对应站点的适配器
// ==========================================

(function () {
  const B = window.AI_BRIDGE;

  function log(...args) {
    console.log("[AI-BRIDGE]", ...args);
  }

  async function handleCommand(msg) {
    const adapter = B.findAdapter();
    if (!adapter) {
      throw new Error("没有匹配的适配器: " + location.host);
    }

    log(`使用适配器: ${adapter.name}, requestId: ${msg.requestId}`);

    // 通知 injected.js 当前的 requestId（用于网络层拦截）
    window.postMessage({
      source: "AI_BRIDGE_SET_REQUEST",
      requestId: msg.requestId,
    }, "*");

    let stopObserve = null;

    // 先开始监听回复，再发送，避免回复太快漏掉
    const onDelta = (text) => {
      B.sendToBackground({
        source: "AI_BRIDGE",
        type: "event",
        requestId: msg.requestId,
        event: "delta",
        text,
      });
    };

    const onDone = () => {
      log("回复完成");
      B.sendToBackground({
        source: "AI_BRIDGE",
        type: "event",
        requestId: msg.requestId,
        event: "done",
      });
    };

    // 启动 DOM 监听
    stopObserve = adapter.observeReply(onDelta, onDone);

    // 通知：已开始
    B.sendToBackground({
      source: "AI_BRIDGE",
      type: "event",
      requestId: msg.requestId,
      event: "started",
    });

    // 发送消息
    try {
      //await adapter.send(msg.prompt, { newChat: msg.newChat });
	  await adapter.send(msg.prompt, { newChat: false });

    } catch (err) {
      if (stopObserve) stopObserve();
      throw err;
    }

    // 超时保护（5 分钟）
    setTimeout(() => {
      if (stopObserve) {
        stopObserve();
        onDone();
      }
    }, 5 * 60 * 1000);
  }

  // 监听来自 background 的命令
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "command") return;

    handleCommand(msg).catch(err => {
      log("处理命令失败:", err);
      B.sendToBackground({
        source: "AI_BRIDGE",
        type: "event",
        requestId: msg.requestId,
        event: "error",
        message: err.message,
      });
    });
  });

  // 监听来自 injected.js 的网络流（如果有）
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "AI_BRIDGE_NET") return;

    // 网络层命中时，可以让 DOM 监听提前结束，
    // 但这里我们先保持简单，只用 DOM 结果，避免重复发送
    // 若后续想启用网络层，可以在这里做去重
  });

  log("content.js loaded on", location.host);
})();