<div align="center">

# ⚡ amux (Agent Multiplexer)

**AI 编程 Agent 界的 `tmux`。在 OpenAI Codex 与 Google Antigravity 之间实现原生会话双向克隆与项目列表同步。**

[![GitHub Stars](https://img.shields.io/github/stars/study8677/amux?style=for-the-badge&logo=github&color=gold)](https://github.com/study8677/amux/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-orange.svg?style=for-the-badge)](https://github.com/study8677/amux/pulls)

**[简体中文](README.md)** · **[English](README_EN.md)** · **[系统架构设计](docs/architecture.md)**

</div>

---

## 💡 为什么需要 amux？

如果你在日常开发中同时使用 **OpenAI Codex** 和 **Google Antigravity**，你一定深受以下折磨：

- **会话割裂**：在 Antigravity 聊了半天，切到 Codex 历史列表是一片空白。你必须在输入框长篇大论重新交代背景，或者两边来回翻看旧记录。
- **工具噪音污染**：原始会话里充斥着几十次底层的探测命令（`ls`、`cat`、`pwd`）和错误堆栈，直接塞给另一个 Agent 既浪费 Token 又容易导致混乱。
- **项目不同步**：在一个工具里新建或改名了项目，另一个工具里又得手动重复建一遍。

**`amux` 用最直观的方式终结了这一切**：
> 在任意一个 Agent 里聊完，切到另一个 Agent，**整段对话已经以清爽的原生聊天气泡排在左侧列表里了**，点进去直接敲键盘接着聊！

---

## 🌟 核心特性

### 🔄 1. 双向原生会话克隆（去除一切工具噪音）
- 在 Antigravity 聊完代码，打开 Codex Desktop，左侧列表里**已为你准备好刚刚的完整会话**！
- **智能去噪过滤器**：坚决剔除 `ls`、`cat`、`pwd` 等底层探测命令、错误堆栈与系统注入标签，只保留真实的人类提问与 Agent 给出的代码方案及结论。
- **官方接口级安全注入**：调用 Codex 官方内置 `app-server` 的 JSON-RPC 接口（`thread/start` + `thread/inject_items`），绝不暴力直接修改 SQLite 数据库。

### 🗂 2. 全局项目双向自动对齐
- 自动发现 Codex 和 Antigravity 在当前电脑上的全部项目；
- 支持项目新建、改名、删除双向同步；
- 内置写前自动快照备份与**“单次删除超过 30% 自动熔断暂停”**的安全防护网。

### ⚡ 3. 零感知后台守护进程
- 内存常驻 < 40MB，近乎零 CPU 占用；
- 对话事件防抖 3 秒后自动克隆，并每 10 秒扫描会话变化作为兜底。

---

## ⚡ 极速上手（让你的 AI 帮你一键搞定）

不用自己繁琐地敲命令！**复制下面这段话直接发送给你当前的 AI 编程助手（Antigravity / Codex / Cursor / Claude 等）**，让它帮你全自动克隆、编译并启动：

> 🤖 **把以下指令发给你的 AI：**
> 
> ```markdown
> 请帮我安装并配置 amux (Agent Multiplexer)：
> 1. 在本地克隆 https://github.com/study8677/amux 并执行 npm install && npm run build && npm link
> 2. 执行 amux projects sync --yes 对齐我电脑上的 Codex 和 Antigravity 项目列表
> 3. 执行 amux daemon start 在后台启动守护进程，并告诉我运行状态
> ```

---

<details>
<summary>🛠️ <b>喜欢纯手动安装？点击展开手动命令行步骤</b></summary>

### 1. 克隆与全局链接
```bash
git clone https://github.com/study8677/amux.git
cd amux
npm install
npm run build
npm link
```

### 2. 双向对齐项目列表
```bash
# 预览
amux projects list

# 执行安全对齐（写前自动备份）
amux projects sync --yes
```

### 3. 一键克隆当前会话
在 Antigravity 聊完，想切到 Codex 接着聊？
```bash
amux mirror
```

### 4. 启动后台守护进程（全程免手动）
```bash
# 启动后台守护进程
amux daemon start

# 查看状态与实时日志
amux daemon status
amux daemon log
```

</details>

### 本机运行状态页

执行 `amux daemon start` 后，打开 [运行状态页](http://127.0.0.1:4317)。页面每 5 秒刷新后台心跳、最近扫描、同步结果、错误和项目配对。

macOS 使用两个独立的 launchd 服务运行同步后台和状态页，支持登录启动及异常退出自动恢复。`amux daemon stop` 会暂停同步，状态页继续显示停止状态。再次执行 `amux daemon start` 可恢复。

页面会分别显示历史写入记录和原生读回校验结果。状态页还会显示最近一次模型续聊、回复落盘及独立重载的验收结果。Antigravity 原生导入已在本机 2.31 版本验证。

---

## 🏗 整体架构全景

```text
               ┌────────────────────────────────────────────────────────┐
               │             amux 跨 Agent 极简架构                      │
               └────────────────────────────────────────────────────────┘

    ┌──────────────────────────┐                          ┌──────────────────────────┐
    │     Google Antigravity   │                          │       OpenAI Codex       │
    │  - brain/transcript.jsonl│                          │  - sessions/*.jsonl      │
    │  - summaries.db (SQLite) │                          │  - state_5.sqlite        │
    └─────────────┬────────────┘                          └────────────┬─────────────┘
                  │                                                    │
                  ▼                                                    ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 1. 采集与嗅探层 (ActivityTracker + Chokidar 毫秒级探测)                          │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 2. 纯净提纯层 (剥离 <environment_context>，过滤 ls/cat/pwd 工具噪音与报错堆栈)  │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 3. 原生会话克隆引擎                                                            │
    │    ├─ Codex 注入       : 官方 `thread/start` + `thread/inject_items` RPC 注入   │
    │    └─ Antigravity 注入 : 原生 SQLite 模板 + `LoadSharedTrajectory` 导入       │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 4. CLI & Background Supervisor (`amux mirror`, `amux projects`, `amux daemon`) │
    └────────────────────────────────────────────────────────────────────────────────┘
```

---

## 💻 CLI 命令速查

```bash
amux mirror               # 将当前项目最新会话清洗并克隆到对向 Agent
amux projects list        # 查看 Codex 与 Antigravity 的项目配对状态
amux projects sync --yes  # 立即执行项目双向对齐
amux daemon start|stop    # 启动/停止后台守护进程
amux daemon status        # 查看守护进程状态
amux daemon log           # 查看实时镜像克隆日志
amux dashboard            # 单独启动本机运行状态页
```

---

## 🛡 安全与稳定性设计

1. **零破坏写入**：写 Codex 会话一律走其原生内置的 `codex app-server` RPC 通道，杜绝在应用运行时直接修改主 SQLite 数据库导致的文件损坏或死锁。
2. **写前自动快照**：任何涉及项目配置变更的操作，均在 `~/.amux/backups/` 保留带时间戳的完整备份。
3. **批量删除熔断保护**：当自动检测到单次删除项目超过 30% 时，强制暂停并等待人工 `--yes` 确认。

---

## 🤝 参与贡献

欢迎提交 Issue 与 Pull Request！让更多的开发者摆脱 Agent 上下文孤岛的困扰。

---

## 📄 开源许可

[MIT License](LICENSE) © [study8677](https://github.com/study8677)
