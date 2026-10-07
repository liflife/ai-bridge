// ==========================================
// sites/wenxin.js — 百度文心一言适配器
// 目标站点: chat.baidu.com (原 wenxin.baidu.com / yiyan.baidu.com)
// ==========================================
(function () {
  const B = window.AI_BRIDGE;
  if (!B) { console.error("[wenxin] AI_BRIDGE 未加载"); return; }

  B.register({
    name: "wenxin",                              // ★ 改这里
    host: ["chat.baidu.com"],

    selectors: {
      newChat:
        'button[aria-label*="新建"], ' +
        'button[aria-label*="New chat"], ' +
        'div[class*="new-chat"], ' +
        'div[class*="newChat"]',

      input: "#chat-textarea",

      send:
        '#chat-submit-button, ' +
        'button[aria-label*="发送"], ' +
        'button[aria-label*="Send"], ' +
        'button[type="submit"]',

      reply:
        '[class*="answer-content"], ' +
        '[class*="markdown-body"], ' +
        '[class*="assistant-message"]',
    },

    async send(prompt, { newChat }) {
      console.log("[wenxin] send, newChat =", newChat);

      if (newChat) {
        const newBtn = document.querySelector(this.selectors.newChat);
        if (newBtn) {
          console.log("[wenxin] 点击新建会话");
          newBtn.click();
          await B.sleep(800);
        }
      }

      const input = await B.waitFor(
        () => document.querySelector(this.selectors.input),
        10000
      );
      console.log("[wenxin] 找到输入框");

      input.focus();
      try {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, "value"
        ).set;
        setter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (e) {
        console.warn("[wenxin] 清空输入框失败:", e.message);
      }

      B.setInputValue(input, prompt);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await B.sleep(200 + Math.random() * 200);

      const sendBtn = document.querySelector(this.selectors.send);
      if (sendBtn && !sendBtn.disabled) {
        console.log("[wenxin] 点击发送按钮");
        sendBtn.click();
        return;
      }

      console.warn("[wenxin] 未找到发送按钮，尝试 Enter");
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    },

    observeReply(onDelta, onDone) {
      const REPLY_SEL = this.selectors.reply;

      const extractText = (node) => {
        if (!node) return "";
        const clone = node.cloneNode(true);

        clone.querySelectorAll("pre").forEach(pre => {
          const code = pre.querySelector("code");
          const text = code ? (code.textContent || "") : (pre.textContent || "");
          pre.replaceWith(document.createTextNode(text));
        });

        clone.querySelectorAll("button, [role='button']").forEach(n => n.remove());

        clone.querySelectorAll(
          '[class*="code-header"], [class*="code-toolbar"], ' +
          '[class*="toolbar"], [class*="copy"], [class*="download"]'
        ).forEach(n => n.remove());

        return clone.textContent || "";
      };

      const isLikelyComplete = (text) => {
        if (!text || text.length < 10) return false;

        const hasOpen = text.includes("<<<CONTENT>>>");
        const hasClose = text.includes("<<<END_CONTENT>>>");
        if (hasOpen && !hasClose) return false;
        if (!hasOpen && hasClose) return false;

        const fenceCount = (text.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) return false;

        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (escape) { escape = false; continue; }
          if (ch === "\\") { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        if (depth !== 0) return false;

        return true;
      };

      const getLastNode = () => {
        const nodes = document.querySelectorAll(REPLY_SEL);
        if (nodes.length === 0) return null;
        return nodes[nodes.length - 1];
      };

      let lastQuickText = "";
      let lastFullText = "";

      const getText = () => {
        const node = getLastNode();
        if (!node) return "";
        const quick = node.textContent || "";
        if (quick === lastQuickText) return lastFullText;
        lastQuickText = quick;
        lastFullText = extractText(node);
        return lastFullText;
      };

      const initialNode = getLastNode();
      const initialQuick = initialNode ? (initialNode.textContent || "") : "";
      lastQuickText = initialQuick;

      console.log("[wenxin] 开始监听, 基准长度:", initialQuick.length);

      let doneTimer = null;
      let stopped = false;
      let firstSeenAt = 0;
      let lastSeenText = "";

      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(pollTimer);
        clearInterval(idleTimer);
        clearTimeout(hardTimeout);
        clearTimeout(doneTimer);
        console.log("[wenxin] 停止监听, 最终长度:", lastFullText.length);
      };

      const finish = (reason) => {
        if (stopped) return;
        if (!lastFullText) return;
        console.log(`[wenxin] 判定完成 (${reason}), 长度:`, lastFullText.length);
        onDelta(lastFullText);
        onDone();
        stop();
      };

      const pollTimer = setInterval(() => {
        if (stopped) return;

        const cur = getText();
        if (!cur) return;
        if (cur === initialQuick) return;

        if (!firstSeenAt) firstSeenAt = Date.now();

        const changed = cur !== lastSeenText;
        if (changed) {
          lastSeenText = cur;
          if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
        }

        if (!isLikelyComplete(cur)) {
          if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
          return;
        }

        if (doneTimer) return;

        doneTimer = setTimeout(() => {
          if (stopped) return;
          if (!isLikelyComplete(lastFullText)) { doneTimer = null; return; }
          finish("1s 稳定");
        }, 1000);
      }, 150);

      const hardTimeout = setTimeout(() => {
        if (stopped) return;
        if (!lastFullText) {
          console.warn("[wenxin] 180 秒未捕获内容");
          onDelta(""); onDone(); stop();
        } else {
          finish("180s 硬超时");
        }
      }, 180 * 1000);

      const idleTimer = setInterval(() => {
        if (stopped) return;
        if (!lastFullText || !firstSeenAt) return;
        const idleFor = Date.now() - firstSeenAt;
        if (!isLikelyComplete(lastFullText) && idleFor > 60 * 1000) {
          finish("60s 静默强制");
        }
      }, 5000);

      return stop;
    },
  });

  console.log("[wenxin] 适配器已注册");
})();