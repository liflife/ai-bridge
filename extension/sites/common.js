// ==========================================
// sites/common.js
// 共享工具函数 + 适配器注册表
// 所有站点文件都会用到
// ==========================================

(function () {
  if (window.__AI_BRIDGE_LOADED__) return;
  window.__AI_BRIDGE_LOADED__ = true;

  const AI_BRIDGE = {
    adapters: [],

    // 注册一个站点适配器
    register(adapter) {
      if (!adapter || !adapter.name || !adapter.host) {
        console.warn("[AI-BRIDGE] 无效的适配器:", adapter);
        return;
      }
      this.adapters.push(adapter);
      console.log("[AI-BRIDGE] 已注册适配器:", adapter.name);
    },

    // 根据当前 host 找适配器
    findAdapter(host = location.host) {
      return this.adapters.find(a =>
        Array.isArray(a.host) ? a.host.some(h => host.includes(h)) : host.includes(a.host)
      );
    },

    // ---------- 工具函数 ----------
    sleep(ms) {
      return new Promise(r => setTimeout(r, ms));
    },

    async waitFor(fn, timeout = 10000, interval = 200) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const result = fn();
        if (result) return result;
        await this.sleep(interval);
      }
      throw new Error("等待元素超时");
    },

    // 通用输入框写入（兼容 textarea / input / contenteditable）
    setInputValue(el, text) {
      if (!el) throw new Error("找不到输入框");
      el.focus();

      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        const proto = el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      if (el.isContentEditable) {
        // 先清空
        el.innerHTML = "";
        el.focus();
        // 用 execCommand 保留撤销栈和框架监听
        document.execCommand("insertText", false, text);
        // 一些框架（React）需要额外触发
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
        return;
      }

      throw new Error("不支持的输入框类型: " + el.tagName);
    },

    // 安全地发送消息给 background
    sendToBackground(data) {
      try {
        if (chrome.runtime?.id) {
          chrome.runtime.sendMessage(data).catch(() => {});
        }
      } catch (e) {
        // 扩展上下文失效，忽略
      }
    },
  };

  window.AI_BRIDGE = AI_BRIDGE;
  console.log("[AI-BRIDGE] common.js loaded");
})();