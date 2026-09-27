```markdown
# AI Bridge — 把网页版 AI 变成可编程的 Agent

通过 Chrome 扩展接管**你自己登录的** AI 网页（DeepSeek / ChatGPT / Claude / Gemini / Kimi），暴露一个 OpenAI 兼容的本地 API，并在此之上构建：

- 🤖 **命令行 Agent**（`cli.js`）—— 类似 Claude Code 的交互式助手
- 🌐 **Web UI**（`ui/`）—— 图形化项目管理 + 会话
- 🔌 **HTTP API**（`server.js`）—— 任何程序都能调

**核心理念**：不抓 cookie、不盗 token、不逆向接口，只操作你**真实打开的浏览器**，把网页能力转成 API。

---

## 目录

- [它能做什么](#它能做什么)
- [架构](#架构)
- [特性](#特性)
- [前置要求](#前置要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
  - [命令行 Agent](#命令行-agent)
  - [Web UI](#web-ui)
  - [HTTP API](#http-api)
- [支持的 AI 站点](#支持的-ai-站点)
- [内置工具](#内置工具)
- [目录结构](#目录结构)
- [数据存储](#数据存储)
- [配置](#配置)
- [FAQ](#faq)
- [免责声明](#免责声明)

---

## 它能做什么

```
你：帮我看看 F:/project/demo 下的代码结构，生成一个 README

Agent：
  1. list_dir("F:/project/demo")
  2. read_file("F:/project/demo/package.json")
  3. read_file("F:/project/demo/src/index.js")
  4. write_file("F:/project/demo/README.md", "...")
  5. final_answer("已生成 README.md，包含项目结构、安装方式和使用说明")
```

Agent 通过提示词让 AI 输出**结构化 JSON 决策**，本地程序解析后**执行真实操作**（读写文件、执行命令、搜索代码），再把结果反馈给 AI，循环直到任务完成。

**支持的任务**：

- 📝 生成代码、重构、加注释
- 🔍 分析项目结构、找 bug、读日志
- 📄 批量生成文档、README、CHANGELOG
- ⚙️ 执行 shell 命令、跑测试、装依赖
- 🌐 抓取网页内容

---

## 架构

```bash
┌────────────────────────────────────────────────────────┐
│  调用方                                                 │
│   ├─ CLI（agent/cli.js）                                │
│   ├─ Web UI（ui/）                                      │
│   └─ 任意程序（HTTP）                                   │
└────────────────┬───────────────────────────────────────┘
                 │ HTTP / SSE
                 ▼
┌────────────────────────────────────────────────────────┐
│  Bridge Server（server/server.js）                      │
│   - HTTP :8787  /v1/chat/completions                    │
│   - WS   :8765  与扩展通信                              │
└────────────────┬───────────────────────────────────────┘
                 │ WebSocket
                 ▼
┌────────────────────────────────────────────────────────┐
│  Chrome 扩展（extension/）                              │
│   - background.js  连接本地服务                         │
│   - content.js     路由到站点适配器                     │
│   - sites/*.js     各站点操作逻辑                       │
└────────────────┬───────────────────────────────────────┘
                 │ DOM 操作
                 ▼
┌────────────────────────────────────────────────────────┐
│  真实 AI 网页（你已登录）                               │
│  DeepSeek / ChatGPT / Claude / Gemini / Kimi            │
└────────────────────────────────────────────────────────┘
```

**关键设计**：

- 不接触账号密码，不导出 Cookie
- 走真实浏览器 + 真实用户目录
- 每个 AI 站点一个独立适配器，互不影响
- Agent 只用**本地文件系统**和**本地 shell**，不做网络代理

---

## 特性

### Agent

- ✅ **ReAct 循环**：思考 → 调用工具 → 观察结果 → 继续
- ✅ **无损内容传输**：用 `<<<CONTENT>>>` 标记包裹代码，避免 JSON 转义地狱
- ✅ **取消任务**：Ctrl+C 优雅中止，通知扩展停止
- ✅ **步数限制**：防止死循环（默认 100 步）
- ✅ **自动重试**：JSON 解析失败让 LLM 重做一次

### CLI

- ✅ **粘贴多行**：直接粘贴长文本，回车确认
- ✅ **`@` 文件引用**：输入 `@` 弹出文件选择器
- ✅ **Tab 补全**：命令和路径补全
- ✅ **项目概念**：按 cwd 自动映射到项目
- ✅ **会话保存/加载**：随时恢复上次对话
- ✅ **多行任务**：粘贴的文本保持原格式

### Web UI

- ✅ **项目管理**：为每个代码目录建一个项目
- ✅ **会话列表**：一个项目下多个会话
- ✅ **实时进度**：SSE 流式显示每一步
- ✅ **停止按钮**：随时取消任务

### 扩展

- ✅ **站点适配器**：每个 AI 网站独立 JS 文件
- ✅ **自动选标签页**：多开时优先激活窗口
- ✅ **会话 URL 上报**：自动保存网页会话 UUID
- ✅ **自动重载**：content script 失效时自动 refresh

---

## 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 需要原生 `fetch` |
| Chrome / Edge | ≥ 111 | 扩展需 MV3 + `world: "MAIN"` |
| 操作系统 | Windows / macOS / Linux | 已测试：Windows 10/11 |

---

## 安装

### 1. 克隆项目

```bash
git clone <repo-url> ai-bridge
cd ai-bridge
```

或者直接把整个 `ai-bridge/` 目录放到任意位置。

### 2. 安装依赖

```bash
# Bridge 服务
cd server
npm install

# Agent
cd ../agent
npm install

# Web UI
cd ../ui
npm install
```

### 3. 加载 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `ai-bridge/extension` 目录
5. 确认扩展列表中出现了 **Local AI Bridge**

### 4. 登录 AI 网页

用 Chrome 打开并登录**至少一个**支持的站点：

- https://chat.deepseek.com/
- https://chatgpt.com/
- https://claude.ai/
- https://gemini.google.com/
- https://www.kimi.com/

保持页面打开，扩展会自动注入。

---

## 快速开始

### 启动 Bridge 服务

```bash
cd server
node server.js
```

看到：

```
API: http://127.0.0.1:8787
[Server] Extension connected
```

**`Extension connected` 是关键**，没出现说明扩展没连上。

### 启动 CLI

另开一个终端：

```bash
cd agent
node cli.js
```

看到 banner 后：

```
agent> 在当前目录写一个 hello.py，输出 Hello World
```

Agent 会调用 AI 网页完成任务，文件生成在**启动 cli.js 时的 cwd**。

---

## 使用指南

### 命令行 Agent

```bash
cd F:\project\myapp       # 切到你想让 agent 工作的目录
node F:\project\ai-bridge\agent\cli.js
```

#### 基础命令

| 命令 | 功能 |
|---|---|
| `/help` | 显示帮助 |
| `/exit` `/quit` | 退出 |
| `/clear` | 清屏 |
| `/status` | 当前状态 |
| `/history` | 任务历史 |

#### 会话管理

| 命令 | 功能 |
|---|---|
| `/new` | 开始新会话 |
| `/save [name]` | 保存会话（默认用网页 UUID 命名） |
| `/load [编号\|name]` | 加载会话 |
| `/sessions` | 列出当前项目的会话 |
| `/unsave <name>` | 删除会话 |

#### 项目管理

| 命令 | 功能 |
|---|---|
| `/projects` | 列出所有项目 |
| `/project` | 显示当前项目 |
| `/project <key>` | 切换项目 |

#### 站点

| 命令 | 功能 |
|---|---|
| `/site <name>` | 切换 AI 站点 |
| `/sites` | 列出支持的站点 |

#### `@` 文件引用

**方式 1：交互式选择**

```
agent> @
（回车）

📁 选择文件
   目录: F:\project\myapp

   [1]  ↩  ../
   [2]  📁 src/
   [3]  📄 package.json                              1.2 KB
   [4]  📄 index.js                                  5.6 KB

选择 > 3

agent> @package.json ▊
```

**方式 2：直接输入**

```
agent> 分析 @src/index.js 有哪些问题
```

**方式 3：Tab 补全**

```
agent> 分析 @src/i<Tab>
```

#### 粘贴多行

直接 `Ctrl+V` 粘贴多行文本，回车确认。

#### 取消任务

- 第一次 `Ctrl+C`：取消当前任务
- 再次 `Ctrl+C`：强制退出

---

### Web UI

启动：

```bash
cd ui
node server.js
```

浏览器打开 `http://127.0.0.1:3000`。

#### 创建项目

1. 点击 **+ 新建项目**
2. 填：
   - 名称：`myapp`
   - 路径：`F:/project/myapp`
3. 点击 **创建**

**项目 = 一个代码目录**。Agent 在这个目录下读写文件。

#### 使用

- 点击项目名展开，看到会话列表
- 点击会话切换
- 顶栏显示当前项目的**完整路径**
- 输入任务 → `Ctrl+Enter` 发送

#### 与 CLI 共享

Web UI 和 CLI 用**同一个 `~/.ai-bridge-agent/projects/` 目录**。

- CLI 在 `F:\project\myapp` 下启动 → 自动创建同名项目
- Web UI 里也能看到这个项目及所有会话

---

### HTTP API

OpenAI 兼容接口：

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "web-ai",
    "site": "deepseek",
    "session_id": "my-session",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

**参数**：

| 参数 | 说明 |
|---|---|
| `site` | `deepseek` / `chatgpt` / `claude` / `gemini` / `kimi` |
| `session_id` | 会话 ID（相同 ID 复用网页会话） |
| `new_chat` | `true` 强制新建网页会话 |
| `messages` | OpenAI 格式，只取最后一条 |

**其他接口**：

| 接口 | 功能 |
|---|---|
| `GET /v1/sessions` | 列出所有活跃会话 |
| `GET /v1/sessions/:id` | 查询单个会话 |
| `POST /v1/sessions/bind` | 手动绑定 session → url |

---

## 支持的 AI 站点

| 站点 | 站点 key | 适配器文件 |
|---|---|---|
| DeepSeek | `deepseek` | `extension/sites/deepseek.js` |
| ChatGPT | `chatgpt` | `extension/sites/chatgpt.js` |
| Claude | `claude` | `extension/sites/claude.js` |
| Gemini | `gemini` | `extension/sites/gemini.js` |
| Kimi | `kimi` | `extension/sites/kimi.js` |

**添加新站点**：

1. 在 `extension/sites/` 下新建 `newsite.js`
2. 复制 `deepseek.js` 作为模板，修改：
   - `name` / `host`
   - `selectors.input` / `selectors.send` / `selectors.reply`
   - `observeReply` 的 DOM 观察逻辑
3. 在 `extension/manifest.json` 的 `matches` 和 `content_scripts.js` 里加入
4. 在 `server.js` 的 `SITE_URLS` 里加入（用于新会话）

---

## 内置工具

Agent 可调用的工具（见 `agent/tools.js`）：

### 读取

| 工具 | 参数 | 功能 |
|---|---|---|
| `read_file` | `path` | 读整个文件 |
| `read_lines` | `path, start, end` | 读指定行范围 |
| `head` | `path, n` | 读前 N 行 |
| `tail` | `path, n` | 读后 N 行 |
| `list_dir` | `path` | 列目录 |
| `file_exists` | `path` | 判断存在 |
| `file_stat` | `path` | 文件信息 |

### 搜索

| 工具 | 参数 | 功能 |
|---|---|---|
| `search_files` | `pattern, path` | glob 匹配文件名 |
| `grep` | `pattern, path, options` | 按内容正则搜索 |

### 写入

| 工具 | 参数 | 功能 |
|---|---|---|
| `write_file` | `path` + `<<<CONTENT>>>` | 写文件 |
| `append_file` | `path` + `<<<CONTENT>>>` | 追加 |
| `mkdir` | `path` | 创建目录 |

### 删除/移动

| 工具 | 参数 | 功能 |
|---|---|---|
| `delete_file` | `path` | 删文件 |
| `delete_dir` | `path` | 删目录（含内容） |
| `move_file` | `from, to` | 移动/重命名 |
| `copy_file` | `from, to` | 复制 |

### 系统

| 工具 | 参数 | 功能 |
|---|---|---|
| `exec_shell` | `cmd` | 执行命令（30s 超时） |
| `fetch_url` | `url` | 抓网页（前 2000 字） |

**安全限制**（`assertSafePath`）：

- 禁止操作盘符根（`C:\`）
- 禁止操作用户主目录本身
- 其他路径无限制（谨慎使用 `delete_dir`）

---

## 目录结构

```
ai-bridge/
├── server/                 # 桥接服务
│   ├── package.json
│   └── server.js           # HTTP :8787 + WS :8765
│
├── extension/              # Chrome 扩展
│   ├── manifest.json
│   ├── background.js       # Service Worker
│   ├── content.js          # 路由器
│   ├── injected.js         # MAIN world 注入
│   └── sites/              # 站点适配器
│       ├── common.js
│       ├── deepseek.js
│       ├── chatgpt.js
│       ├── claude.js
│       ├── gemini.js
│       └── kimi.js
│
├── agent/                  # Agent 核心
│   ├── package.json
│   ├── agent.js            # 主循环
│   ├── tools.js            # 工具集
│   ├── llm.js              # 调 Bridge 的客户端
│   ├── cli.js              # 命令行 REPL
│   ├── run.js              # 一次性任务
│   └── test.js             # 单元测试
│
└── ui/                     # Web 界面
    ├── package.json
    ├── server.js           # :3000
    └── public/
        ├── index.html
        ├── style.css
        └── app.js
```

---

## 数据存储

所有持久化数据在 `~/.ai-bridge-agent/`：

```
~/.ai-bridge-agent/
└── projects/
    ├── myapp/
    │   ├── project.json           # { name, key, path, ... }
    │   └── sessions/
    │       ├── 29eaa2a6-....json  # 会话数据
    │       └── s-1790....json
    └── another/
        ├── project.json
        └── sessions/
```

**会话文件格式**：

```json
{
  "sessionId": "cli-1790...",
  "site": "deepseek",
  "url": "https://chat.deepseek.com/a/chat/s/...",
  "createdAt": "...",
  "updatedAt": "...",
  "taskCount": 3,
  "taskHistory": [
    { "task": "...", "ok": true, "elapsed": 12345 }
  ]
}
```

**项目映射规则**：

- CLI 启动时取 `process.cwd()` 的 basename 作为项目 key
- 同名不同路径 → 加 hash 后缀（如 `myapp-a1b2c3`）
- Web UI 可手动指定

---

## 配置

### 修改端口

`server/server.js`：

```js
app.listen(8787, ...)                     // HTTP
new WebSocketServer({ port: 8765, ... })  // WS
```

`extension/background.js` 里对应的 WebSocket 地址也要改：

```js
const LOCAL_WS = "ws://127.0.0.1:8765/ws?token=LOCAL_TOKEN";
```

### 更换默认站点

- **CLI**：`/site <name>`
- **Web UI**：下拉框
- **默认值**：`agent/cli.js` 里的 `STATE.site`

### 步数/超时

`agent/agent.js` 的 `runAgent` 参数：

```js
maxSteps = 100              // 最大步数
```

`extension/content.js` 里的超时：

```js
}, 5 * 60 * 1000);          // 5 分钟无回复强制结束
```

---

## FAQ

### Q: `Extension connected` 不出现

1. 确认 `node server.js` 正在跑
2. `chrome://extensions/` 里点扩展的 **Service Worker** 看控制台
3. 检查是否有 `Local WS connected`
4. 关掉其它占用 8765 端口的程序

### Q: 命令发出后 AI 网页没反应

1. **刷新 AI 页面**（reload 扩展后必须刷新）
2. F12 看 Console 有没有 `[deepseek] 找到输入框`
3. 没有 → 选择器失效，需要更新 `sites/xxx.js` 的 `selectors`

### Q: 生成的文件在错误目录

- 检查 CLI 启动时的 cwd
- 检查 Web UI 顶栏显示的项目路径
- 检查 `agent.js` 日志有没有 `📂 切换工作目录`

### Q: `write_file` 内容缩进丢失

这是网页渲染问题。当前方案：LLM 用 `<<<CONTENT>>>` 标记包裹，扩展从 `<pre><code>` 提取。

如果丢失：
1. 检查 AI 网页的 DOM 结构是否变了
2. 看 `sites/deepseek.js` 的 `getText` 是否需要调整

### Q: 会不会封号

**风险很低，但无法 100% 避免**。降低风险的做法：

- ✅ 单账号、单机、单 IP
- ✅ 加随机延迟（已内置）
- ✅ 不做无脑循环
- ✅ 不导出 cookie、不上服务器
- ❌ 不要多账号轮询
- ❌ 不要 24 小时不间断运行
- ❌ 不要对外卖 API

**AI 只是返回 JSON 这件事不会封号**。真正触发风控的是**行为模式**。

### Q: 能不能不装扩展，用无头浏览器

技术上可以，但：
- ❌ 无头指纹很容易被识别
- ❌ 需要自己维护登录态
- ❌ 风险更高

**用真实 Chrome + 扩展**是当前最安全的方案。

### Q: 换电脑后怎么迁移

把 `~/.ai-bridge-agent/` 目录复制过去即可。项目、会话全在里面。

### Q: 支持哪些 Node 版本

Node 18+。已在 Node 20 / 22 / 24 上测试通过。

---

## 免责声明

本项目仅供**个人学习与研究**使用。

- 使用者需自行承担账号风控风险
- 请遵守各 AI 网站的服务条款
- 请勿用于：多账号自动化、批量注册、爬虫、对外提供 API 服务
- 作者不对使用本项目造成的任何损失负责

**推荐使用场景**：

- 本地个人助手
- 内部工具链集成
- 不想花 token 费的研究

**不推荐场景**：

- 生产级服务（应用官方 API）
- 团队共享账号
- 对外提供 API

---

## License

MIT
