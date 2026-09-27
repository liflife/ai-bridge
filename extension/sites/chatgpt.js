// sites/chatgpt.js —— 最简版，先保发送
(function () {
  const B = window.AI_BRIDGE;
  if (!B) { console.error("[chatgpt] AI_BRIDGE 未加载"); return; }

  B.register({
    name: "chatgpt",
    host: ["chatgpt.com", "chat.openai.com"],

    selectors: {
      newChat: 'a[href="/"]',
      input: "#prompt-textarea",
      send: 'button[data-testid="send-button"]',
    },

    async send(prompt, { newChat }) {
      console.log("[chatgpt] 准备发送, prompt:", prompt);

      if (newChat) {
        const btn = document.querySelector(this.selectors.newChat);
        if (btn) {
          console.log("[chatgpt] 点击新建会话");
          btn.click();
          await B.sleep(800);
        }
      }

      const input = await B.waitFor(
        () => document.querySelector(this.selectors.input),
        10000
      );
      console.log("[chatgpt] 找到输入框");
      B.setInputValue(input, prompt);
      await B.sleep(300);

      const sendBtn = document.querySelector(this.selectors.send);
      if (sendBtn && !sendBtn.disabled) {
        console.log("[chatgpt] 点击发送按钮");
        sendBtn.click();
      } else {
        console.log("[chatgpt] 用 Enter 发送");
        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, bubbles: true,
        }));
      }
      console.log("[chatgpt] 发送动作完成");
    },

    observeReply(onDelta, onDone) {
      const REPLY_SEL = '[data-message-author-role="assistant"]';

      // 关键：记录监听开始前的 assistant 消息数量
      const initialCount = document.querySelectorAll(REPLY_SEL).length;
      console.log("[chatgpt] 监听开始，已有", initialCount, "条 assistant 消息");

      let lastText = "";
      let doneTimer = null;
      let stopped = false;

      const getText = () => {
        const nodes = document.querySelectorAll(REPLY_SEL);
        // 还没出现新消息，返回空
        if (nodes.length <= initialCount) return "";
        const last = nodes[nodes.length - 1];
        const md = last.querySelector(".markdown") || last;
        return md.innerText || "";
      };

      const stop = () => {
        if (stopped) return;
        stopped = true;
        observer.disconnect();
        clearTimeout(doneTimer);
      };

		const observer = new MutationObserver(() => {
		  const text = getText();
		  if (!text) return;

		  if (text.length > lastText.length && text.startsWith(lastText)) {
			// 正常增长：发增量
			const delta = text.slice(lastText.length);
			if (delta) {
			  console.log("[chatgpt] delta:", delta.slice(0, 30));
			  onDelta(delta);
			}
			lastText = text;
		  } else if (text.length === lastText.length) {
			// 长度不变，忽略
		  } else if (text.length < lastText.length) {
			// 变短了 → DOM 重渲染，忽略，不动 lastText
			console.log("[chatgpt] 文本变短（重渲染），忽略");
		  } else {
			// 变长但不以 lastText 开头 → 结构突变，跳过这一帧
			console.log("[chatgpt] 文本突变（非前缀），跳过");
		  }

		  clearTimeout(doneTimer);
		  doneTimer = setTimeout(() => {
			console.log("[chatgpt] 判定完成, 最终长度:", lastText.length);
			onDone();
			stop();
		  }, 2500);
		});

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      return stop;
    },
  });
})();