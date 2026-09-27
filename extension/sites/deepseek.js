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
      input.focus();

      B.setInputValue(input, prompt);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await B.sleep(500 + Math.random() * 400);

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

      console.warn("[deepseek] 无发送按钮，尝试 Enter（可能被拒绝）");
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
    },

    // ---------- 非流式：累积完整文本，done 时一次性发送 ----------
    observeReply(onDelta, onDone) {
      const REPLY_SEL = this.selectors.reply;
      const initialCount = document.querySelectorAll(REPLY_SEL).length;
      console.log("[deepseek] 开始监听，已有", initialCount, "条答案节点");

      let lastFullText = "";
      let doneTimer = null;
      let stopped = false;

      // ★ 只取 pre 里 <code> 的原始文本，其它普通文本用 textContent
		const getText = () => {
		  const nodes = document.querySelectorAll(REPLY_SEL);
		  if (nodes.length <= initialCount) return "";
		  const last = nodes[nodes.length - 1];

		  const clone = last.cloneNode(true);

		  // 1. pre → 内容替换（保留缩进和换行）
		  clone.querySelectorAll("pre").forEach(pre => {
			const code = pre.querySelector("code");
			const text = code ? (code.textContent || "") : (pre.textContent || "");
			pre.replaceWith(document.createTextNode(text));
		  });

		  // 2. 删按钮（复制、下载）
		  clone.querySelectorAll("button, [role='button']").forEach(n => n.remove());

		  // 3. 删代码块头部容器（"agent 复制 下载" 那一栏）
		  clone.querySelectorAll(
			'[class*="code-header"], [class*="code-toolbar"], [class*="code-block-header"], ' +
			'[class*="toolbar"], [class*="copy"], [class*="download"]'
		  ).forEach(n => n.remove());

		  // 4. 遍历文本节点，删纯语言名
		  const JUNK_RE = /^\s*(agent|python|py|javascript|js|typescript|ts|java|c\+\+|cpp|c#|csharp|go|golang|rust|ruby|php|swift|kotlin|bash|sh|shell|sql|html|css|json|xml|yaml|yml|markdown|md|text|plaintext|plain|复制|下载|copy|download)\s*$/i;
		  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
		  const toRemove = [];
		  while (walker.nextNode()) {
			const node = walker.currentNode;
			if (JUNK_RE.test(node.textContent || "")) toRemove.push(node);
		  }
		  toRemove.forEach(n => n.remove());

		  return clone.textContent || "";
		};

      const stop = () => {
        if (stopped) return;
        stopped = true;
        observer.disconnect();
        clearTimeout(doneTimer);
        console.log("[deepseek] 停止监听, 最终长度:", lastFullText.length);
      };

      const observer = new MutationObserver(() => {
        const text = getText();
        if (!text) return;

        // 只累积，不发 delta
        if (text !== lastFullText) {
          lastFullText = text;
        }

        // 3 秒无变化 → 判定完成
        clearTimeout(doneTimer);
        doneTimer = setTimeout(() => {
          if (!lastFullText) {
            console.warn("[deepseek] 超时但无内容，直接结束");
            onDone();
            stop();
            return;
          }
          console.log("[deepseek] 判定完成，一次性发送完整文本, 长度:", lastFullText.length);
          // ★ 只发一次 delta（完整文本），紧跟 done
          onDelta(lastFullText);
          onDone();
          stop();
        }, 3000);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      return stop;
    },
  });

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