<div align="center">

# ⚡ amux (Agent Multiplexer)

**AI 编程 Agent 界的 `tmux`。在 OpenAI Codex 与 Google Antigravity 之间实现无缝上下文接力、原生会话双向克隆与项目列表同步。**

[![GitHub Stars](https://img.shields.io/github/stars/study8677/amux?style=for-the-badge&logo=github&color=gold)](https://github.com/study8677/amux/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)

[English](README.md) · [简体中文](README_CN.md) · [系统架构设计](docs/architecture.md)

</div>

---

## 💡 为什么需要 amux？

在现代 AI 辅助研发中，很多开发者会同时使用 **OpenAI Codex** 和 **Google Antigravity**。然而，当你在同一个项目中从一个 Agent 切换到另一个时，通常会遇到以下四大痛点：

| 痛点场景 | 以前的折磨 😩 | 使用 amux 之后 🚀 |
| :--- | :--- | :--- |
| **上下文断层** | 换个工具就得在输入框长篇大论重新交代背景、刚刚改了哪、做到哪一步。 | **零冷启动接力**：新 Agent 启动瞬间自动感知全部前序背景。 |
| **重复踩坑** | Codex 刚试过一个报错走不通的方案，切到 Antigravity，它又推荐了一遍一模一样的坑。 | **避坑雷达 (`Tried & Failed`)**：自动提炼历史报错与走不通的路径，严禁后序 Agent 重复尝试。 |
| **会话割裂** | Antigravity 聊了半天，Codex 界面里一片空白，必须来回切窗口看历史。 | **原生会话克隆 (Mirror)**：自动将对话直接以**清晰的气泡**克隆在另一边的历史列表里，输入框接着聊！ |
| **项目列表不同步** | 在一边建了新项目，另一边又得手动点半天重新导入。 | **双向项目自动对齐**：任意一边新建/改名/删除，全机自动双向同步。 |

---

## 🌟 核心特性

### 🔄 1. 双向原生会话克隆（去除一切工具噪音）
- 在 Antigravity 聊完，打开 Codex Desktop，左侧列表里**已为你准备好刚刚的完整会话**！
- **智能去噪过滤器**：坚决剔除 `ls`、`cat`、`pwd` 等底层探测命令、错误堆栈与系统标签，只保留真实的人类提问与 Agent 给出的代码方案及结论。
- **官方接口级安全注入**：调用 Codex 官方内置 `app-server` 的 JSON-RPC 接口（`thread/start` + `thread/inject_items`），绝不暴力直接修改 SQLite 数据库。

### 🧠 2. 实时交接状态蒸馏 (`.amux/HANDOFF.md`)
- 自动提取最近对话，蒸馏生成高信噪比、极低 Token 占用的交接摘要。
- 核心提炼字段：
  - 🎯 **当前推进目标 (Objective)**
  - 📐 **已敲定架构设计决策 (Decisions)**
  - 🚫 **重点避坑区 (Tried & Failed)**：防止下一个 Agent 踩同一个坑
  - 📂 **最近读写热点文件 (Active Files)**

### 🗂 3. 全局项目双向自动对齐
- 自动发现 Codex 和 Antigravity 在当前电脑上的全部项目；
- 支持项目新建、改名、删除双向同步；
- 内置写前自动快照备份与**“单次删除超过 30% 自动熔断暂停”**的安全防护网。

### 🔌 4. 内置标准 MCP Server
- 原生支持 Model Context Protocol (MCP) stdio 协议；
- 为 Agent 提供专属工具：`get_handoff_context`、`record_decision_or_pitfall`、`list_projects`。

---

## 🏗 整体架构全景

```text
               ┌────────────────────────────────────────────────────────┐
               │             amux 跨 Agent 四层数据流架构                │
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
    │ 3. 双轨投递与克隆层                                                            │
    │    ├─ 通道 A (会话级克隆 Mirror)：                                              │
    │    │   ├─ Codex: 官方 `thread/start` + `thread/inject_items` RPC 注入原生会话   │
    │    │   └─ Antigravity: 写入 `transcript.jsonl` + 注册 summaries.db             │
    │    └─ 通道 B (HANDOFF.md 备忘与 MCP stdio 服务)                                 │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 4. CLI & Daemon 层 (`amux mirror`, `amux daemon`, `amux projects`)             │
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

### 1. 一键全局初始化
注入全局 Agent 行为守则（`~/.codex/AGENTS.md` 和 `~/.gemini/GEMINI.md`）并注册 amux MCP 服务：
```bash
amux setup
```

### 2. 双向对齐项目列表
```bash
# 预览将要对齐的项目
amux projects sync

# 正式执行对齐（写前自动备份）
amux projects sync --yes
```

### 3. 一键克隆/镜像当前会话
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
  · 会话 ID: 01a1c46b-1acb-71a3-866b-3448f7a0a486
  👉 打开 Codex Desktop 即可在左侧列表看到该会话，直接输入继续交流！
```

### 4. 启动静默后台守护进程（全程免手动）
```bash
# 启动后台守护进程
amux daemon start

# 查看后台运行状态
amux daemon status

# 实时查看同步日志
amux daemon log
```

---

## 💻 CLI 常用命令速查

```bash
amux mirror               # 将当前项目最新会话清洗并克隆到对向 Agent
amux projects list        # 查看 Codex 与 Antigravity 的项目配对状态
amux projects sync --yes  # 立即执行项目双向对齐
amux watch                # 前台实时监听面板（显示捕获轮次与刷新日志）
amux sync                 # 立即刷新当前项目的 HANDOFF.md
amux status               # 查看当前项目的交接状态摘要（目标/踩坑/决策）
amux daemon start|stop    # 启动/停止后台守护进程
amux mcp                  # 以 stdio 模式启动 MCP 服务
```

---

## 🛡 安全与稳定性设计

1. **零破坏写入**：写 Codex 会话一律走其原生内置的 `codex app-server` RPC 通道，杜绝在应用运行时直接修改主 SQLite 数据库导致的文件损坏或死锁。
2. **写前自动快照**：任何涉及项目配置变更的操作，均在 `~/.amux/backups/` 保留带时间戳的完整备份。
3. **批量删除熔断保护**：当自动检测到单次删除项目超过 30% 时，强制暂停并等待人工 `--yes` 确认。
4. **Git 无侵入**：自动将 `.amux/` 维护在 `.git/info/exclude` 中，绝不污染代码库的历史提交。

---

## 🤝 参与贡献

欢迎提出 Issue 和 PR！更多开发细节请阅读 [贡献指南](CONTRIBUTING.md)。

---

## 📄 开源许可

[MIT License](LICENSE) © [study8677](https://github.com/study8677)
