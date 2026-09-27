export const adapters = {
 deepseek: {
    host: "chat.deepseek.com",
    newChat: 'button[aria-label="New chat"], [data-testid="new-chat-button"], .sidebar__new-chat',
    input: '#chat-input',
    send: 'button[type="submit"], div[role="button"][aria-label*="发送"], .composer__btn--send',
    reply: '.markdown-body:last-child, .message-bubble:last-child .markdown-body'
  },
  chatgpt: {
    host: "chatgpt.com",
    newChat: 'a[href="/"]',
    input: "#prompt-textarea",
    send: 'button[data-testid="send-button"]',
    reply: '[data-message-author-role="assistant"]'
  },
  claude: {
    host: "claude.ai",
    newChat: 'a[href="/new"]',
    input: 'div[contenteditable="true"]',
    send: 'button[aria-label="Send message"]',
    reply: '[data-testid="assistant-message"]'
  },
  gemini: {
    host: "gemini.google.com",
    newChat: 'button[aria-label="New chat"]',
    input: 'div[contenteditable="true"]',
    send: 'button[aria-label="Send message"]',
    reply: "model-response"
  }
};

export function getAdapter() {
  const host = location.host;
  return Object.values(adapters).find(a => host.includes(a.host));
}