// ==========================================
// sites/deepseek.js
// ==========================================
(function () {
  const B = window.AI_BRIDGE;
  if (!B) { console.error("[deepseek] AI_BRIDGE 未加载"); return; }

  B.register({
    name: "deepseek",
    host: "chat.deepseek.com",

    selectors: {
      newChat:
        'button[aria-label*="新对话"], ' +
        'button[aria-label*="New chat"], ' +
        'div[role="button"][aria-label*="新对话"], ' +
        'div[role="button"][aria-label*="New chat"]',

      input:
        'textarea[placeholder*="发送消息"], ' +
        'textarea[placeholder*="DeepSeek"], ' +
        'textarea',

      send:
        'button[aria-label*="发送"], ' +
        'button[aria-label*="Send"], ' +
        'div[role="button"][aria-label*="发送"], ' +
        'div[role="button"][aria-label*="Send"], ' +
        'button[type="submit"]',

      reply:
        '.ds-markdown.ds-assistant-message-main-content, ' +
        '[class*="assistant-message-main-content"]',
    },

    // ==========================================
    // 发送消息
    // ==========================================
    async send(prompt, { newChat }) {
      console.log("[deepseek] send, newChat =", newChat);

      if (newChat) {
        const newBtn = document.querySelector(this.selectors.newChat);
        if (newBtn) {
          console.log("[deepseek] 点击新建会话");
          newBtn.click();
          await B.sleep(1200);
        }
      }

      const input = await B.waitFor(
        () => document.querySelector(this.selectors.input),
        10000
      );
      console.log("[deepseek] 找到输入框");

      // ★ 先清空输入框（第二轮可能残留）
      input.focus();
      try {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, "value"
        ).set;
        setter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await B.sleep(100);
      } catch (e) {
        console.warn("[deepseek] 清空输入框失败:", e.message);
      }

      // 写入内容
      B.setInputValue(input, prompt);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await B.sleep(600 + Math.random() * 400);

      // 找发送按钮
      const sendBtn = document.querySelector(this.selectors.send);
      console.log("[deepseek] 发送按钮:", sendBtn ? sendBtn.className.slice(0, 50) : "未找到");

      if (sendBtn) {
        const disabled = sendBtn.disabled || sendBtn.getAttribute("aria-disabled") === "true";
        if (!disabled) {
          console.log("[deepseek] 点击发送按钮");
          sendBtn.click();
          return;
        }
        console.log("[deepseek] 发送按钮被禁用");
      }

      const nearBtn = findNearbyButton(input);
      if (nearBtn) {
        console.log("[deepseek] 通过邻近查找点击发送按钮");
        nearBtn.click();
        return;
      }

      console.warn("[deepseek] 无发送按钮，尝试 Enter");
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    },

    // ==========================================
    // 监听回复 —— 非流式，累积完整文本，done 时一次性发送
    // 核心：不依赖节点数量，用"基准文本"判断新回复
    // ==========================================
    observeReply(onDelta, onDone) {
      const REPLY_SEL = this.selectors.reply;

      // ---------- 文本提取（保留缩进、剥离 UI） ----------
      const extractText = (node) => {
        if (!node) return "";
        const clone = node.cloneNode(true);

        // pre → code 的 textContent
        clone.querySelectorAll("pre").forEach(pre => {
          const code = pre.querySelector("code");
          const text = code ? (code.textContent || "") : (pre.textContent || "");
          pre.replaceWith(document.createTextNode(text));
        });

        // 删按钮
        clone.querySelectorAll("button, [role='button']").forEach(n => n.remove());

        // 删代码块头部
        clone.querySelectorAll(
          '[class*="code-header"], [class*="code-toolbar"], [class*="code-block-header"], ' +
          '[class*="toolbar"], [class*="copy"], [class*="download"]'
        ).forEach(n => n.remove());

        // 删纯语言名文本节点
        const JUNK_RE = /^\s*(agent|python|py|javascript|js|typescript|ts|java|go|rust|bash|sh|shell|sql|html|css|json|xml|yaml|text|plaintext|复制|下载|copy|download)\s*$/i;
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        const toRemove = [];
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (JUNK_RE.test(n.textContent || "")) toRemove.push(n);
        }
        toRemove.forEach(n => n.remove());

        return clone.textContent || "";
      };

      // ---------- 取当前最后一条答案的文本 ----------
      const getLastText = () => {
        const nodes = document.querySelectorAll(REPLY_SEL);
        if (nodes.length === 0) return "";
        return extractText(nodes[nodes.length - 1]);
      };

      // ---------- 记录基准 ----------
      const initialLastText = getLastText();
      console.log("[deepseek] 开始监听, 基准最后一条长度:", initialLastText.length);

      let lastFullText = "";
      let stableTicks = 0;
      let doneTimer = null;
      let stopped = false;
      let startedAt = Date.now();

      const STABLE_NEEDED = 10; // 300ms * 10 = 3 秒稳定

      // ---------- 完成 ----------
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(pollTimer);
        clearTimeout(hardTimeout);
        console.log("[deepseek] 停止监听, 最终长度:", lastFullText.length);
      };

      const finish = () => {
        if (stopped) return;
        if (!lastFullText) return;
        console.log("[deepseek] 判定完成，一次性发送完整文本, 长度:", lastFullText.length);
        onDelta(lastFullText);
        onDone();
        stop();
      };

      // ---------- 轮询 ----------
      const pollTimer = setInterval(() => {
        if (stopped) return;

        const cur = getLastText();
        if (!cur) return;

        // 关键：只有当"最后一条文本"和"基准文本"不同时，才是新回复
        // 如果 initialLastText 为空，则任何非空文本都算新回复
        if (cur === initialLastText) return;

        // 是新回复
        if (cur !== lastFullText) {
          // 内容还在变化
          lastFullText = cur;
          stableTicks = 0;
          // 重置"稳定判定"
          clearTimeout(doneTimer);
          doneTimer = setTimeout(() => {
            finish();
          }, 3000);
        } else {
          // 内容未变化
          stableTicks++;
          // 双保险：即使 doneTimer 意外被清，稳定也完成
          if (stableTicks >= STABLE_NEEDED) {
            finish();
          }
        }
      }, 300);

      // ---------- 兜底：90 秒无内容强制结束 ----------
      const hardTimeout = setTimeout(() => {
        if (stopped) return;
        if (!lastFullText) {
          console.warn("[deepseek] 90 秒内未捕获到新内容，强制结束");
          onDelta("");
          onDone();
          stop();
        }
      }, 90 * 1000);

      return stop;
    },
  });

  // ==========================================
  // 从输入框向上找"发送按钮"
  // ==========================================
  function findNearbyButton(el) {
    let p = el.parentElement;
    for (let i = 0; i < 6 && p && p !== document.body; i++, p = p.parentElement) {
      const btns = [...p.querySelectorAll("button")];
      if (btns.length > 0 && btns.length < 6) {
        const svgBtn = btns.find(b => b.querySelector("svg"));
        if (svgBtn) return svgBtn;
        const sendBtn = btns.find(b => /send|submit/i.test(b.className));
        if (sendBtn) return sendBtn;
        if (btns.length === 1) return btns[0];
      }
    }
    return null;
  }

  console.log("[deepseek] 适配器已注册");
})();