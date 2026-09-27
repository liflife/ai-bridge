// ==========================================
// ui/public/app.js
// ==========================================

const $ = (sel) => document.querySelector(sel);

// ==========================================
// 状态
// ==========================================
const state = {
  site: "deepseek",
  projects: [],
  activeProjectKey: null,
  activeSessionId: null,
  expandedProjects: new Set(),
  busy: false,
  currentTaskId: null,
};

// ==========================================
// DOM
// ==========================================
const messagesEl = $("#messages");
const inputEl = $("#task-input");
const btnSend = $("#btn-send");
const btnStop = $("#btn-stop");
const btnNewProject = $("#btn-new-project");
const projectListEl = $("#project-list");
const projectCountEl = $("#project-count");
const siteSelectEl = $("#site-select");
const statusTextEl = $("#status-text");
const sessionIdDisplayEl = $("#session-id-display");
const topbarPathEl = $("#topbar-path");
const topbarSessionEl = $("#topbar-session");

// @ 候选浮层
const atPopupEl = $("#at-popup");
const atListEl = $("#at-list");

// 项目模态框
const projectModalEl = $("#project-modal");
const projectNameInput = $("#project-name-input");
const projectPathInput = $("#project-path-input");
const projectCancelBtn = $("#project-cancel");
const projectConfirmBtn = $("#project-confirm");

// ==========================================
// @ 候选状态
// ==========================================
const AT = {
  visible: false,
  entries: [],
  selected: 0,
  startPos: -1,     // 输入串里 "@" 的下标
  endPos: -1,       // 输入串里 "@xxx" 的结束下标（= 光标位置）
  query: "",
  requestId: 0,
};

// ==========================================
// 工具
// ==========================================
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function setStatus(text, type = "normal") {
  statusTextEl.textContent = text;
  statusTextEl.style.color =
    type === "error" ? "var(--error)"
    : type === "busy" ? "var(--accent)"
    : "var(--text-hint)";
}

function genSessionId() {
  return "s-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ==========================================
// 顶栏 / 输入控制
// ==========================================
function updateTopbar() {
  const proj = state.projects.find(p => p.key === state.activeProjectKey);
  if (proj) {
    topbarPathEl.textContent = proj.path;
    topbarPathEl.title = proj.path;
  } else {
    topbarPathEl.textContent = "未选择项目";
    topbarPathEl.title = "";
  }
  topbarSessionEl.textContent = state.activeSessionId || "";
}

function updateInputEnabled() {
  const canSend = !!state.activeProjectKey && !!state.activeSessionId;
  inputEl.disabled = !canSend;
  btnSend.disabled = !canSend || state.busy;
}

// ==========================================
// @ 候选浮层
// ==========================================

/** 从光标位置向前找最近一个 @ 到光标的片段 */
function getAtQuery() {
  const value = inputEl.value;
  const cursor = inputEl.selectionStart;
  const before = value.slice(0, cursor);
  // 匹配 @ 后跟非空白字符到光标
  const m = before.match(/@([^\s@]*)$/);
  if (!m) return null;
  const startPos = cursor - m[0].length;
  return {
    startPos,
    endPos: cursor,
    query: m[1], // 不含 @
  };
}

async function refreshAtCandidates() {
  const q = getAtQuery();
  if (!q) {
    hideAtPopup();
    return;
  }
  if (!state.activeProjectKey) {
    hideAtPopup();
    return;
  }

  AT.startPos = q.startPos;
  AT.endPos = q.endPos;
  AT.query = q.query;

  // 拆出目录部分和基础部分
  const slash = q.query.lastIndexOf("/");
  const dir = slash >= 0 ? q.query.slice(0, slash) : "";
  const base = slash >= 0 ? q.query.slice(slash + 1) : q.query;

  AT.requestId++;
  const myReq = AT.requestId;

  try {
    const url = `/api/browse?projectKey=${encodeURIComponent(state.activeProjectKey)}&dir=${encodeURIComponent(dir)}`;
    const res = await fetch(url);
    if (!res.ok) {
      hideAtPopup();
      return;
    }
    if (myReq !== AT.requestId) return; // 有更新请求先返回了

    const data = await res.json();
    let entries = data.entries || [];

    // 前端按 base 前缀过滤（后端也可以做，这里更方便）
    if (base) {
      const lower = base.toLowerCase();
      entries = entries.filter(e => e.name.toLowerCase().startsWith(lower));
    }

    if (entries.length === 0) {
      hideAtPopup();
      return;
    }

    AT.entries = entries;
    AT.selected = 0;
    AT.visible = true;
    renderAtPopup();
  } catch {
    hideAtPopup();
  }
}

function renderAtPopup() {
  atListEl.innerHTML = "";
  AT.entries.forEach((e, i) => {
    const li = document.createElement("li");
    li.className = "at-item" + (i === AT.selected ? " selected" : "");
    li.dataset.idx = i;

    const icon = e.isDir ? "📁" : "📄";
    const sizeStr = e.isDir ? "" : formatSize(e.size || 0);

    li.innerHTML = `
      <span class="at-item-icon">${icon}</span>
      <span class="at-item-name">${escapeHtml(e.name)}${e.isDir ? "/" : ""}</span>
      ${sizeStr ? `<span class="at-item-size">${sizeStr}</span>` : ""}
    `;

    li.addEventListener("mousedown", (ev) => {
      // mousedown 优先于 blur，避免点一下 textarea 失焦再处理
      ev.preventDefault();
      AT.selected = i;
      applyAtCandidate();
    });
    li.addEventListener("mouseenter", () => {
      AT.selected = i;
      renderAtPopup();
    });

    atListEl.appendChild(li);
  });

  // 滚动到选中项
  const selectedEl = atListEl.querySelector(".selected");
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: "nearest" });
  }

  atPopupEl.style.display = "flex";
}

function hideAtPopup() {
  AT.visible = false;
  AT.entries = [];
  AT.selected = 0;
  atPopupEl.style.display = "none";
}

function applyAtCandidate() {
  const item = AT.entries[AT.selected];
  if (!item) return;

  const value = inputEl.value;
  const before = value.slice(0, AT.startPos);
  const after = value.slice(AT.endPos);

  let insert;
  if (item.isDir) {
    // 目录：替换为 @dir/ 后继续触发候选
    insert = "@" + item.relPath;
    const newValue = before + insert + after;
    inputEl.value = newValue;
    const newCursor = before.length + insert.length;
    inputEl.setSelectionRange(newCursor, newCursor);
    // 刷新候选
    refreshAtCandidates();
  } else {
    // 文件：替换为 @file 后加空格
    insert = "@" + item.relPath + " ";
    const newValue = before + insert + after;
    inputEl.value = newValue;
    const newCursor = before.length + insert.length;
    inputEl.setSelectionRange(newCursor, newCursor);
    hideAtPopup();
  }

  autoGrow();
  inputEl.focus();
}

function atPopupKeyHandler(e) {
  if (!AT.visible) return false;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    AT.selected = Math.min(AT.entries.length - 1, AT.selected + 1);
    renderAtPopup();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    AT.selected = Math.max(0, AT.selected - 1);
    renderAtPopup();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    applyAtCandidate();
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    hideAtPopup();
    return true;
  }
  return false;
}

// ==========================================
// 项目列表
// ==========================================
async function loadProjects() {
  try {
    const res = await fetch("/api/projects");
    const data = await res.json();
    state.projects = data.projects || [];
    renderProjects();
  } catch (e) {
    console.error("加载项目失败", e);
  }
}

function renderProjects() {
  projectCountEl.textContent = state.projects.length;
  projectListEl.innerHTML = "";

  if (state.projects.length === 0) {
    const li = document.createElement("li");
    li.style.cssText = "padding:14px 10px;font-size:12px;color:var(--text-hint);text-align:center;";
    li.textContent = "暂无项目，点击上方新建";
    projectListEl.appendChild(li);
    return;
  }

  state.projects.forEach((proj) => {
    const li = document.createElement("li");
    li.className = "project-group";
    if (state.expandedProjects.has(proj.key)) li.classList.add("expanded");

    const isActive = proj.key === state.activeProjectKey;

    li.innerHTML = `
      <div class="project-header ${isActive ? "active" : ""}">
        <div class="project-name">
          <span class="project-arrow">▶</span>
          <span>${escapeHtml(proj.name)}</span>
        </div>
        <div class="project-actions">
          <button class="btn-icon-sm btn-del-project" title="删除项目">✕</button>
        </div>
      </div>
      <div class="project-body">
        <div class="project-path" title="${escapeHtml(proj.path)}">${escapeHtml(proj.path)}</div>
        <button class="btn-new-session">+ 新建会话</button>
        <ul class="session-sublist"></ul>
      </div>
    `;

    const header = li.querySelector(".project-header");
    header.onclick = (e) => {
      if (e.target.classList.contains("btn-del-project")) return;
      toggleProject(proj.key);
    };

    li.querySelector(".btn-del-project").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`删除项目 "${proj.name}"？\n（不会删除本地文件，只删除项目和会话记录）`)) return;
      await fetch(`/api/projects/${encodeURIComponent(proj.key)}`, { method: "DELETE" });
      if (state.activeProjectKey === proj.key) {
        state.activeProjectKey = null;
        state.activeSessionId = null;
        resetMessages();
        updateTopbar();
        updateInputEnabled();
      }
      await loadProjects();
    };

    li.querySelector(".btn-new-session").onclick = (e) => {
      e.stopPropagation();
      createSession(proj.key);
    };

    projectListEl.appendChild(li);

    if (state.expandedProjects.has(proj.key)) {
      loadSessionsInto(li.querySelector(".session-sublist"), proj.key);
    }
  });
}

async function loadSessionsInto(ul, key) {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(key)}/sessions`);
    const data = await res.json();
    const sessions = data.sessions || [];

    ul.innerHTML = "";
    if (sessions.length === 0) {
      const li = document.createElement("li");
      li.style.cssText = "font-size:11px;color:var(--text-hint);padding:4px 10px;";
      li.textContent = "暂无会话";
      ul.appendChild(li);
      return;
    }

    sessions.forEach((s) => {
      const li = document.createElement("li");
      li.className = "session-item";
      if (s.sessionId === state.activeSessionId) li.classList.add("active");

      const displayId = s.sessionId.length > 20
        ? s.sessionId.slice(0, 17) + "..."
        : s.sessionId;

      li.innerHTML = `
        <div class="session-item-name" title="${escapeHtml(s.sessionId)}">${escapeHtml(displayId)}</div>
        <div class="session-item-meta">
          <span>${s.taskCount || 0} 条</span>
          <span> · </span>
          <span>${(s.updatedAt || "").slice(5, 16)}</span>
        </div>
      `;
      li.onclick = (e) => {
        e.stopPropagation();
        selectSession(key, s.sessionId, s);
      };
      ul.appendChild(li);
    });
  } catch (e) {
    console.error("加载会话失败", e);
  }
}

function toggleProject(key) {
  if (state.expandedProjects.has(key)) {
    state.expandedProjects.delete(key);
  } else {
    state.expandedProjects.add(key);
    state.activeProjectKey = key;
    updateTopbar();
  }
  renderProjects();
}

// ==========================================
// 创建项目 / 会话
// ==========================================
function openProjectModal() {
  if (state.busy) return;
  projectNameInput.value = "";
  projectPathInput.value = "";
  projectModalEl.style.display = "flex";
  setTimeout(() => projectNameInput.focus(), 50);
}

function closeProjectModal() {
  projectModalEl.style.display = "none";
}

async function confirmCreateProject() {
  const name = projectNameInput.value.trim();
  const p = projectPathInput.value.trim().replace(/\\/g, "/");
  if (!name || !p) {
    setStatus("请填写名称和路径", "error");
    return;
  }
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, path: p }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "创建失败", "error");
      return;
    }

    closeProjectModal();

    state.expandedProjects.add(data.project.key);
    state.activeProjectKey = data.project.key;
    if (data.firstSession) {
      state.activeSessionId = data.firstSession.sessionId;
    }

    updateTopbar();
    updateInputEnabled();
    resetMessages();
    await loadProjects();

    setStatus(`项目已创建: ${data.project.name}  (会话: ${state.activeSessionId})`);
    inputEl.focus();
  } catch (e) {
    setStatus("创建失败: " + e.message, "error");
  }
}

async function createSession(projectKey) {
  if (state.busy) {
    console.warn("[createSession] busy, 跳过");
    return;
  }
  const sessionId = genSessionId();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, site: state.site }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus("创建会话失败: " + (data.error || res.status), "error");
      return;
    }
    state.activeProjectKey = projectKey;
    state.activeSessionId = sessionId;
    state.expandedProjects.add(projectKey);
    updateTopbar();
    updateInputEnabled();
    resetMessages();
    await loadProjects();
    setStatus("新会话已创建");
    inputEl.focus();
  } catch (e) {
    setStatus("创建失败: " + e.message, "error");
  }
}

function selectSession(projectKey, sessionId, sessionData) {
  if (state.busy) return;
  state.activeProjectKey = projectKey;
  state.activeSessionId = sessionId;
  state.expandedProjects.add(projectKey);
  if (sessionData?.site) state.site = sessionData.site;
  siteSelectEl.value = state.site;

  updateTopbar();
  updateInputEnabled();

  messagesEl.innerHTML = "";
  const th = sessionData?.taskHistory || [];
  if (th.length === 0) {
    messagesEl.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon">🤖</div>
        <div class="welcome-title">会话已就绪</div>
        <div class="welcome-hint">输入任务开始对话</div>
      </div>
    `;
  } else {
    th.forEach((h) => {
      appendUserMessage(h.task);
      if (h.ok && h.answer) {
        appendAnswer(h.answer);
      } else if (h.ok) {
        appendAnswer("(历史任务，内容略)");
      } else {
        appendError("(历史任务失败)");
      }
    });
  }

  renderProjects();
  setStatus("已切换到会话: " + sessionId);
}

// ==========================================
// 消息渲染
// ==========================================
function resetMessages() {
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">🤖</div>
      <div class="welcome-title">会话已就绪</div>
      <div class="welcome-hint">输入任务开始对话</div>
    </div>
  `;
}

function clearWelcome() {
  const w = messagesEl.querySelector(".welcome");
  if (w) w.remove();
}

function appendUserMessage(text) {
  clearWelcome();
  const div = document.createElement("div");
  div.className = "msg msg-user";
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function createStepCard(step, maxSteps) {
  const card = document.createElement("div");
  card.className = "step-card";
  card.innerHTML = `
    <div class="step-card-header">
      <span class="spinner"></span>
      <span>步骤 ${step} / ${maxSteps}</span>
    </div>
    <div class="step-card-body"></div>
  `;
  messagesEl.appendChild(card);
  scrollToBottom();
  return card;
}

function addStepLine(card, icon, text) {
  const body = card.querySelector(".step-card-body");
  const line = document.createElement("div");
  line.className = "step-line";
  line.innerHTML = `<span class="icon">${icon}</span><span class="text">${escapeHtml(text)}</span>`;
  body.appendChild(line);
  scrollToBottom();
}

function addToolBlock(card, text, ok) {
  const body = card.querySelector(".step-card-body");
  const block = document.createElement("div");
  block.className = "tool-block " + (ok ? "ok" : "err");
  block.textContent = text;
  body.appendChild(block);
  scrollToBottom();
}

function finishStepCard(card) {
  const h = card.querySelector(".step-card-header .spinner");
  if (h) h.remove();
}

function appendAnswer(text) {
  const div = document.createElement("div");
  div.className = "answer-card";
  div.innerHTML = `
    <div class="answer-header">🎉 任务完成</div>
    <div class="answer-body">${escapeHtml(text)}</div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function appendError(text) {
  const div = document.createElement("div");
  div.className = "error-card";
  div.innerHTML = `❌ ${escapeHtml(text)}`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function appendAborted() {
  const div = document.createElement("div");
  div.className = "aborted-card";
  div.textContent = "⏹️ 任务已取消";
  messagesEl.appendChild(div);
  scrollToBottom();
}

// ==========================================
// 发送
// ==========================================
async function sendTask() {
  const task = inputEl.value.trim();
  if (!task) return;
  if (state.busy) return;
  if (!state.activeProjectKey || !state.activeSessionId) return;

  hideAtPopup();

  inputEl.value = "";
  inputEl.style.height = "auto";
  appendUserMessage(task);

  state.busy = true;
  updateInputEnabled();
  btnStop.style.display = "inline-block";
  setStatus("执行中...", "busy");

  let stepCardRef = { current: null };

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        sessionId: state.activeSessionId,
        site: state.site,
        projectKey: state.activeProjectKey,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop();

      for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.split("\n");
        let event = "message";
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataStr += line.slice(6);
        }
        let data = null;
        try { data = JSON.parse(dataStr); } catch {}

        if (event === "task-id" && data) {
          state.currentTaskId = data.taskId;
        } else if (event === "agent-event" && data) {
          handleAgentEvent(data, stepCardRef);
        } else if (event === "error" && data) {
          appendError(data.message || "未知错误");
        }
      }
    }
  } catch (err) {
    appendError(err.message);
  } finally {
    state.busy = false;
    state.currentTaskId = null;
    btnStop.style.display = "none";
    updateInputEnabled();
    setStatus("就绪");
    inputEl.focus();
    await loadProjects();
    renderProjects();
  }
}

function handleAgentEvent(e, ref) {
  if (e.type === "started") {
    ref.current = null;
    return;
  }
   // ★ 新增：显示附件摘要
  if (e.type === "attachments") {
    const okCount = e.attachments.filter(a => !a.error).length;
    const errCount = e.attachments.length - okCount;
    const text = `📎 引用 ${okCount} 个文件` + (errCount ? `（${errCount} 个失败）` : "");
    setStatus(text);
    return;
  }
  if (e.type === "workdir") return;
  if (e.type === "step-start") {
    if (ref.current) finishStepCard(ref.current);
    ref.current = createStepCard(e.step, e.maxSteps);
    return;
  }
  if (!ref.current) ref.current = createStepCard(1, 100);
  if (e.type === "llm-reply") return;
  if (e.type === "log") {
    addStepLine(ref.current, e.icon, e.text);
    return;
  }
  if (e.type === "tool-call") {
    const summary = summarizeInput(e.toolName, e.input);
    addStepLine(ref.current, "🔧", `调用 ${e.toolName} ${summary}`);
    return;
  }
  if (e.type === "tool-result") {
    const preview = String(e.observation || "").slice(0, 500);
    addToolBlock(ref.current, preview, e.ok);
    return;
  }
  if (e.type === "done") {
    if (ref.current) finishStepCard(ref.current);
    if (e.ok) appendAnswer(e.answer || "(无内容)");
    else if (e.reason === "workdir_invalid") appendError(e.message || "工作目录无效");
    else if (e.reason === "parse_error") appendError("解析失败，请重试");
    else if (e.reason === "max_steps") appendError("超过最大步数，任务未完成");
    else appendError("任务失败: " + (e.reason || "未知"));
    ref.current = null;
  }
}

function summarizeInput(toolName, input) {
  if (!input) return "";
  if (toolName === "write_file") {
    const size = input.content ? `(${input.content.length} 字符)` : "";
    return `${input.path || "?"} ${size}`;
  }
  if (input.path) return input.path;
  if (input.cmd) return `"${String(input.cmd).slice(0, 40)}"`;
  if (input.url) return input.url;
  if (input.pattern) return `"${input.pattern}"`;
  return "";
}

// ==========================================
// 停止
// ==========================================
async function stopTask() {
  if (!state.currentTaskId) return;
  try {
    await fetch("/api/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: state.currentTaskId }),
    });
    appendAborted();
  } catch {}
}

// ==========================================
// textarea 自适应高度
// ==========================================
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

// ==========================================
// 事件绑定
// ==========================================
btnSend.onclick = sendTask;
btnStop.onclick = stopTask;
btnNewProject.onclick = openProjectModal;

projectCancelBtn.onclick = closeProjectModal;
projectConfirmBtn.onclick = confirmCreateProject;
projectModalEl.addEventListener("click", (e) => {
  if (e.target === projectModalEl) closeProjectModal();
});
projectNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    projectPathInput.focus();
  }
});
projectPathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    confirmCreateProject();
  }
  if (e.key === "Escape") closeProjectModal();
});

// ★ textarea：监听输入、光标变化、键盘
inputEl.addEventListener("input", () => {
  autoGrow();
  refreshAtCandidates();
});

inputEl.addEventListener("click", () => {
  refreshAtCandidates();
});

inputEl.addEventListener("blur", () => {
  // 延迟一点，让 mousedown 有机会处理
  setTimeout(() => hideAtPopup(), 150);
});

inputEl.addEventListener("keydown", (e) => {
  // 候选浮层优先
  if (atPopupKeyHandler(e)) return;

  // Ctrl+Enter 发送
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendTask();
  }
});

siteSelectEl.onchange = () => {
  state.site = siteSelectEl.value;
  setStatus("站点已切换: " + state.site);
};

// ==========================================
// 初始化
// ==========================================
async function init() {
  updateInputEnabled();
  updateTopbar();
  await loadProjects();
  setInterval(loadProjects, 15000);
}

init();