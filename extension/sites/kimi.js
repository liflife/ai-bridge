// sites/claude.js
(function () {
  const B = window.AI_BRIDGE;
  if (!B) return;
  B.register({
    name: "kimi",
    host: "kimi.ai",
    selectors: {
      newChat: 'a[href="/new"]',
      input: 'div[contenteditable="true"].ProseMirror',
      send: 'button[aria-label="Send message"]',
      reply: '[data-testid="assistant-message"], .font-claude-message',
    },
    async send(prompt, { newChat }) {
      if (newChat) {
        const btn = document.querySelector(this.selectors.newChat);
        if (btn) { btn.click(); await B.sleep(800); }
      }
      const input = await B.waitFor(() => document.querySelector(this.selectors.input));
      B.setInputValue(input, prompt);
      await B.sleep(200 + Math.random() * 400);
      const sendBtn = await B.waitFor(() => document.querySelector(this.selectors.send));
      sendBtn.click();
    },
    observeReply(onDelta, onDone) {
      let lastText = "";
      let timer = null;
      const getText = () => {
        const nodes = document.querySelectorAll(this.selectors.reply);
        if (!nodes.length) return "";
        return nodes[nodes.length - 1].innerText || "";
      };
      const observer = new MutationObserver(() => {
        const text = getText();
        if (text && text !== lastText) {
          if (text.startsWith(lastText)) {
            const d = text.slice(lastText.length);
            if (d) onDelta(d);
          } else onDelta(text);
          lastText = text;
        }
        clearTimeout(timer);
        timer = setTimeout(() => { onDone(); observer.disconnect(); }, 2500);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return () => { observer.disconnect(); clearTimeout(timer); };
    },
  });
})();