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

// 项目模态框
const projectModalEl = $("#project-modal");
const projectNameInput = $("#project-name-input");
const projectPathInput = $("#project-path-input");
const projectCancelBtn = $("#project-cancel");
const projectConfirmBtn = $("#project-confirm");

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

// ==========================================
// 顶栏
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

// ==========================================
// 输入启用/禁用
// ==========================================
function updateInputEnabled() {
  const canSend = !!state.activeProjectKey && !!state.activeSessionId;
  inputEl.disabled = !canSend;
  btnSend.disabled = !canSend || state.busy;
}

// ==========================================
// 项目列表渲染
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

    // 如果展开，加载会话
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
// 创建项目
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

    // ★ 直接选中服务端返回的第一个会话
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

// ==========================================
// 创建会话
// ==========================================
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
      const msg = data.error || `HTTP ${res.status}`;
      console.error("[createSession] 失败:", msg);
      setStatus("创建会话失败: " + msg, "error");
      return;
    }
    const data = await res.json();
    console.log("[createSession] 成功:", data.session);
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
    console.error("[createSession] 异常:", e);
    setStatus("创建失败: " + e.message, "error");
  }
}

// ==========================================
// 选择会话
// ==========================================
function selectSession(projectKey, sessionId, sessionData) {
  if (state.busy) return;
  state.activeProjectKey = projectKey;
  state.activeSessionId = sessionId;
  state.expandedProjects.add(projectKey);
  if (sessionData?.site) state.site = sessionData.site;
  siteSelectEl.value = state.site;

  updateTopbar();
  updateInputEnabled();

  // 恢复历史
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
    // 刷新会话列表（更新任务数）
    await loadProjects();
    // 刷新当前项目的会话列表
    const proj = state.activeProjectKey;
    if (proj) {
      const el = projectListEl.querySelector(`[data-key="${proj}"] .session-sublist`);
      // 简单方式：重新渲染
      renderProjects();
    }
  }
}

function handleAgentEvent(e, ref) {
  if (e.type === "started") {
    ref.current = null;
    return;
  }
  if (e.type === "workdir") return;   // 前端不需要展示 workdir（已在顶栏显示）
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

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendTask();
  }
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
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

  // 每 15 秒刷新项目
  setInterval(loadProjects, 15000);
}

init();