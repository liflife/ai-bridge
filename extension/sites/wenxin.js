// ==========================================
// sites/wenxin.js — 百度文心一言适配器
// ==========================================
(function () {
  const B = window.AI_BRIDGE;
  if (!B) { console.error("[wenxin] AI_BRIDGE 未加载"); return; }

  // ==========================================
  // 百度专用输入
  // ==========================================
  function setInputValueBaidu(el, text) {
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, "value"
    ).set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));

    try {
      const ok = document.execCommand("insertText", false, text);
      if (ok && el.value === text) {
        console.log("[wenxin] execCommand 一次性写入成功");
        return;
      }
    } catch (e) {
      console.warn("[wenxin] execCommand 失败:", e.message);
    }

    console.log("[wenxin] 逐字符插入");
    for (const ch of text) {
      try { document.execCommand("insertText", false, ch); } catch {}
    }

    if (el.value !== text) {
      setter.call(el, text);
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: text,
      }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // ==========================================
  // 发送按钮
  // ==========================================
  function findSendButton() {
    const img =
      document.querySelector("#ci-submit-button-ai") ||
      document.querySelector('img[class*="ci-submit-button-ai"]');
    if (img) {
      console.log("[wenxin] 选中发送按钮: IMG", (img.className || "").slice(0, 40));
      return img;
    }
    const span = document.querySelector("span.ci-submit-button");
    if (span) {
      console.warn("[wenxin] ⚠️ 未找到 img，回退到 span（大概率无效）");
      return span;
    }
    return null;
  }

  B.register({
    name: "wenxin",
    host: ["chat.baidu.com", "wenxin.baidu.com", "yiyan.baidu.com"],

    selectors: {
      newChat:
        'button[aria-label*="新建"], ' +
        'button[aria-label*="New chat"], ' +
        'div[class*="new-chat"], ' +
        'div[class*="newChat"], ' +
        '[class*="new-session"]',

      input: "#chat-textarea",

      send: '#ci-submit-button-ai, img[class*="ci-submit-button-ai"]',

      // 回复容器 — 具体值等实测后微调
      reply:
        '[class*="answer-content"], ' +
        '[class*="markdown-body"], ' +
        '[class*="assistant-message"], ' +
        '[class*="chat-message"], ' +
        '[class*="message-content"], ' +
        '[class*="response-content"], ' +
        '[class*="markdown"]',
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

      setInputValueBaidu(input, prompt);
      await B.sleep(500);

      console.log("[wenxin] 写入后 input.value 长度:", input.value.length);

      const sendBtn = findSendButton();
      if (!sendBtn) {
        console.warn("[wenxin] ❌ 找不到发送按钮");
        return;
      }

      console.log("[wenxin] 触发点击:", sendBtn.tagName);
      try { sendBtn.click(); } catch (e) { console.warn("[wenxin] click 异常:", e.message); }
      if (sendBtn.tagName === "IMG" && sendBtn.parentElement) {
        try { sendBtn.parentElement.click(); } catch {}
      }

      await B.sleep(800);
      if (input.value.length === 0) {
        console.log("[wenxin] ✅ 发送成功");
        return;
      }

      console.warn("[wenxin] ⚠️ 输入框未清空，尝试 MouseEvent 序列");
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      try {
        sendBtn.dispatchEvent(new MouseEvent("mousedown", opts));
        sendBtn.dispatchEvent(new MouseEvent("mouseup", opts));
        sendBtn.dispatchEvent(new MouseEvent("click", opts));
      } catch {}

      await B.sleep(500);
      if (input.value.length === 0) {
        console.log("[wenxin] ✅ 二次触发成功");
      } else {
        console.error("[wenxin] ❌ 发送失败，输入框仍有内容");
      }
    },

    observeReply(onDelta, onDone) {
      const REPLY_SEL = this.selectors.reply;

      // ==========================================
      // ★ 提取文本：去空行 + 去占位符
      // ==========================================
      const PLACEHOLDER_PATTERNS = [
        /^正在思考[.。…]*$/,
        /^正在生成[.。…]*$/,
        /^思考中[.。…]*$/,
        /^加载中[.。…]*$/,
        /^请稍候[.。…]*$/,
        /^generating[.…]*$/i,
        /^thinking[.…]*$/i,
      ];

      const extractText = (node) => {
        if (!node) return "";
        const clone = node.cloneNode(true);

        // pre → code
        clone.querySelectorAll("pre").forEach(pre => {
          const code = pre.querySelector("code");
          const text = code ? (code.textContent || "") : (pre.textContent || "");
          pre.replaceWith(document.createTextNode(text));
        });

        // 删按钮/工具栏
        clone.querySelectorAll("button, [role='button']").forEach(n => n.remove());
        clone.querySelectorAll(
          '[class*="code-header"], [class*="code-toolbar"], ' +
          '[class*="toolbar"], [class*="copy"], [class*="download"], ' +
          '[class*="loading"], [class*="spinner"], [class*="dot-"]'
        ).forEach(n => n.remove());

        let text = clone.textContent || "";

        // ★ 去掉多余空行（连续 3 个以上 \n 压成 1 个）
        text = text.replace(/\n{3,}/g, "\n\n");
        // ★ 去掉首尾空白
        text = text.trim();

        return text;
      };

      // ==========================================
      // ★ 完整性检查 — agent 场景核心逻辑
      // ==========================================
      const isLikelyComplete = (text) => {
        if (!text) return false;

        // 1. 去空白后最小长度
        const stripped = text.replace(/\s+/g, "");
        if (stripped.length < 15) return false;

        // 2. 排除占位符（"正在思考"、"加载中"等）
        for (const re of PLACEHOLDER_PATTERNS) {
          if (re.test(stripped)) return false;
        }

        // 3. ★ 必须有 JSON 特征（agent 一定返回 JSON）
        if (!text.includes("{") || !text.includes("}")) return false;

        // 4. CONTENT 块必须配对
        const hasOpen = text.includes("<<<CONTENT>>>");
        const hasClose = text.includes("<<<END_CONTENT>>>");
        if (hasOpen && !hasClose) return false;
        if (!hasOpen && hasClose) return false;

        // 5. markdown 代码块围栏偶数
        const fenceCount = (text.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) return false;

        // 6. JSON 花括号平衡
        let depth = 0, inString = false, escape = false;
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

      let doneTimer = null, stopped = false, firstSeenAt = 0, lastSeenText = "";

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
        // ★ 完成前再检查一次
        if (!isLikelyComplete(lastFullText)) {
          console.log(`[wenxin] finish(${reason}) 时内容仍不完整，跳过`);
          return;
        }
        console.log(`[wenxin] 判定完成 (${reason}), 长度:`, lastFullText.length);
        onDelta(lastFullText);
        onDone();
        stop();
      };

      // ==========================================
      // 轮询
      // ==========================================
      const pollTimer = setInterval(() => {
        if (stopped) return;
        const cur = getText();

        // 无内容 / 与基准相同 → 跳过
        if (!cur || cur === initialQuick) return;

        // 记录首见时间
        if (!firstSeenAt) firstSeenAt = Date.now();

        // 内容变化 → 重置完成倒计时
        if (cur !== lastSeenText) {
          lastSeenText = cur;
          if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
        }

        // ★ 不完整 → 不允许完成
        if (!isLikelyComplete(cur)) {
          if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
          return;
        }

        // 已启动倒计时 → 等它到期
        if (doneTimer) return;

        // 完整且稳定 → 1 秒后完成
        doneTimer = setTimeout(() => {
          if (stopped) return;
          if (!isLikelyComplete(lastFullText)) { doneTimer = null; return; }
          finish("1s 稳定");
        }, 1000);
      }, 150);

      // 兜底 1：180 秒硬超时
      const hardTimeout = setTimeout(() => {
        if (stopped) return;
        if (!lastFullText) {
          console.warn("[wenxin] 180 秒未捕获内容");
          onDelta(""); onDone(); stop();
        } else {
          finish("180s 硬超时");
        }
      }, 180 * 1000);

      // 兜底 2：60 秒静默强制
      const idleTimer = setInterval(() => {
        if (stopped) return;
        if (!lastFullText || !firstSeenAt) return;
        if (!isLikelyComplete(lastFullText) && Date.now() - firstSeenAt > 60 * 1000) {
          finish("60s 静默强制");
        }
      }, 5000);

      return stop;
    },
  });

  console.log("[wenxin] 适配器已注册");
})();