// ==========================================
// content.js
// 唯一职责：接收 background 命令，路由到对应站点的适配器
// ==========================================

(function () {
  const B = window.AI_BRIDGE;

  function log(...args) {
    console.log("[AI-BRIDGE]", ...args);
  }

  // 全局注册表：requestId -> stop 函数
  window.__AI_BRIDGE_current_aborts = window.__AI_BRIDGE_current_aborts || new Map();

  // 判断一个 URL 是否是"真正的会话 URL"
  // 各站点会话 URL 都包含 UUID
  const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
  function isConversationUrl(url) {
    if (!url) return false;
    return UUID_RE.test(url);
  }

  async function handleCommand(msg) {
    const adapter = B.findAdapter();
    if (!adapter) {
      throw new Error("没有匹配的适配器: " + location.host);
    }

    log(`使用适配器: ${adapter.name}, requestId: ${msg.requestId}`);
    log(`sessionId: ${msg.sessionId || "(无)"}`);

    // 记录原始 URL
    const originalUrl = location.href;

    // 通知 injected.js 当前的 requestId
    window.postMessage({
      source: "AI_BRIDGE_SET_REQUEST",
      requestId: msg.requestId,
    }, "*");

    // 本任务的状态
    let stopObserve = null;
    let aborted = false;
    let finished = false;
    let timeoutTimer = null;
    let urlReportTimer = null;

    // ---------- 上报 URL ----------
    const reportUrl = (reason) => {
      if (!msg.sessionId) return;
      const cur = location.href;
      if (!isConversationUrl(cur)) {
        log(`URL 还不是会话 URL，跳过上报 (${reason}):`, cur);
        return;
      }
      log(`上报 URL (${reason}):`, cur);
      B.sendToBackground({
        source: "AI_BRIDGE",
        type: "event",
        event: "url_change",
        sessionId: msg.sessionId,
        site: adapter.name,
        url: cur,
      });
    };

    // 轮询等待 URL 变成会话 URL（每 500ms 检查一次，最多 30 秒）
    const startUrlWatch = () => {
      const start = Date.now();
      const tick = () => {
        if (finished) return;
        const cur = location.href;
        if (isConversationUrl(cur) && cur !== originalUrl) {
          reportUrl("url-watch");
          return; // 上报成功，停止轮询
        }
        if (Date.now() - start > 30000) {
          // 超时，最后试一次
          if (isConversationUrl(cur)) {
            reportUrl("url-watch-timeout");
          }
          return;
        }
        urlReportTimer = setTimeout(tick, 500);
      };
      tick();
    };

    // ---------- 生命周期管理 ----------
    const cleanup = () => {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (urlReportTimer) { clearTimeout(urlReportTimer); urlReportTimer = null; }
      window.__AI_BRIDGE_current_aborts.delete(msg.requestId);
    };

    const onDelta = (text) => {
      if (aborted) return;
      B.sendToBackground({
        source: "AI_BRIDGE",
        type: "event",
        requestId: msg.requestId,
        event: "delta",
        text,
      });
    };

    const onDone = () => {
      if (aborted || finished) return;
      finished = true;
      log("回复完成");

      // ★ 关键：任务完成时主动上报当前 URL
      reportUrl("on-done");

      cleanup();
      B.sendToBackground({
        source: "AI_BRIDGE",
        type: "event",
        requestId: msg.requestId,
        event: "done",
      });
    };

    // ---------- 启动 ----------
    stopObserve = adapter.observeReply(onDelta, onDone);

    // 注册 abort 句柄
    window.__AI_BRIDGE_current_aborts.set(msg.requestId, () => {
      if (finished) return;
      aborted = true;
      finished = true;
      log("收到中止信号, requestId:", msg.requestId);
      try { stopObserve && stopObserve(); } catch (e) { log("stopObserve 抛错:", e); }
      cleanup();
      B.sendToBackground({
        source: "AI_BRIDGE",
        type: "event",
        requestId: msg.requestId,
        event: "aborted",
      });
    });

    // 通知：已开始
    B.sendToBackground({
      source: "AI_BRIDGE",
      type: "event",
      requestId: msg.requestId,
      event: "started",
    });

    // 发送消息
    try {
      await adapter.send(msg.prompt, { newChat: false });
    } catch (err) {
      if (stopObserve) { try { stopObserve(); } catch {} }
      cleanup();
      throw err;
    }

    if (aborted) return;

    // ★ 启动 URL 监听（发送后开始）
    startUrlWatch();

    // 超时保护
    timeoutTimer = setTimeout(() => {
      if (finished) return;
      log("5 分钟超时，强制完成");
      if (stopObserve) { try { stopObserve(); } catch {} }
      onDone();
    }, 5 * 60 * 1000);
  }

  // ==========================================
  // 监听来自 background 的命令
  // ==========================================
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "command") return;

    if (msg.action === "abort") {
      log("收到 abort, requestId:", msg.requestId);
      const stop = window.__AI_BRIDGE_current_aborts.get(msg.requestId);
      if (stop) {
        try { stop(); } catch (e) { log("abort 执行出错:", e); }
      } else {
        log("没有匹配的进行中任务，忽略 abort");
      }
      return;
    }

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

  log("content.js loaded on", location.host);
})();