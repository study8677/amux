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
- 监听到对话产生并停顿 3 秒后，自动将提纯后的会话克隆到对向 Agent。

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
    │    └─ Antigravity 注入 : 写入原生 `transcript.jsonl` + 注册 summaries.db       │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 4. CLI & Background Supervisor (`amux mirror`, `amux projects`, `amux daemon`) │
    └────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ 极速上手

### 环境要求
- macOS（Linux / Windows 适配进行中）
- Node.js >= 20.0.0
- 电脑已安装 OpenAI Codex Desktop 与 Google Antigravity

### 安装与构建

```bash
# 克隆仓库
git clone https://github.com/study8677/amux.git
cd amux

# 安装依赖并构建
npm install
npm run build

# 链接 CLI 到系统全局命令
npm link
```

### 1. 一键克隆当前会话
在 Antigravity 聊完，想切到 Codex 接着聊？
```bash
amux mirror
```
*终端输出效果：*
```text
amux mirror · 正在分析工作区: ~/Documents/project2/amux
✔ 镜像克隆成功！已注入到 OpenAI Codex
  · 会话标题: [来自 Antigravity] 优化数据库查询与前端渲染
  · 提纯轮次: 16 轮 (已剥离所有系统提示词与 ls/cat 工具噪音)
  · 会话 ID: 01a1c558-fd6f-7c20-b442-26bd55581d37
  👉 打开 Codex Desktop 即可在左侧列表看到该会话，直接输入继续交流！
```

### 2. 双向对齐项目列表
```bash
# 预览将要对齐的项目
amux projects list

# 正式执行对齐（写前自动备份）
amux projects sync --yes
```

### 3. 启动后台静默守护进程（全程免手动）
```bash
# 启动后台守护进程
amux daemon start

# 查看后台运行状态
amux daemon status

# 实时查看同步日志
amux daemon log
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
