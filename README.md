<div align="center">

# ⚡ amux (Agent Multiplexer)

**The `tmux` for AI Coding Agents. Seamless context relay & thread mirroring between OpenAI Codex and Google Antigravity.**

[![GitHub Stars](https://img.shields.io/github/stars/study8677/amux?style=for-the-badge&logo=github&color=gold)](https://github.com/study8677/amux/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-orange.svg?style=for-the-badge)](https://github.com/study8677/amux/pulls)

[English](README.md) · [简体中文](README_CN.md) · [Architecture Spec](docs/architecture.md)

</div>

---

## 💡 Why amux?

If you frequently juggle between **OpenAI Codex** and **Google Antigravity** during your daily development workflow, you've definitely suffered from these pain points:

| The Problem | Life Before `amux` 😩 | Life With `amux` 🚀 |
| :--- | :--- | :--- |
| **Context Amnesia** | Switching agents means typing long paragraphs re-explaining the entire problem, architecture decisions, and current progress. | **Zero-lag context relay**: The new agent picks up right where the last one left off. |
| **Repeated Pitfalls** | Agent A just spent 20 minutes failing a build. You switch to Agent B, and it enthusiastically suggests the exact same broken path. | **Pitfall Blacklist (`Tried & Failed`)**: Previous command errors and discarded ideas are automatically flagged. |
| **Split Threads** | Conversations in Antigravity cannot be seen in Codex, forcing you to constantly flip between windows. | **Native Thread Mirroring**: Conversations automatically clone into the other agent's sidebar with clean message bubbles! |
| **Project Desync** | Creating or renaming a project on one tool requires manual setup on the other. | **Bi-directional Project Reconciliation**: Projects stay synchronized across your entire machine. |

---

## 🌟 Key Features

### 🔄 1. Bi-directional Native Thread Mirroring (No Tool Noise)
- In Antigravity discussing an issue? Switch to Codex Desktop and find the **entire conversation already waiting for you in the sidebar**!
- **Intelligent Noise Filter**: Strips out noisy exploration commands (`ls`, `cat`, `pwd`), internal trace stacks, and system tags. Keeps only human intent and agent conclusions.
- **Safe & Native**: Integrates cleanly through Codex's official `app-server` JSON-RPC protocol (`thread/start` + `thread/inject_items`). Never tampers directly with fragile SQLite databases.

### 🧠 2. Real-time Handoff Compactor (`.amux/HANDOFF.md`)
- Automatically captures every conversational turn and compiles a high-signal, token-efficient handoff briefing.
- Summarizes:
  - 🎯 **Current Objective**
  - 📐 **Architectural Decisions**
  - 🚫 **Tried & Failed (Prevents repeating mistakes)**
  - 📂 **Hot Files Being Modified**

### 🗂 3. Bi-directional Project Alignment
- Discovers project roots across Codex and Antigravity.
- Real-time two-way synchronization for project creation, renaming, and deletion with automated pre-operation backups and a safety circuit breaker (pauses bulk deletions > 30%).

### 🔌 4. Built-in MCP Server
- Native Model Context Protocol (MCP) server over stdio.
- Provides agents with on-demand tools: `get_handoff_context`, `record_decision_or_pitfall`, and `list_projects`.

---

## 🏗 System Architecture

```text
               ┌────────────────────────────────────────────────────────┐
               │              amux Architecture Pipeline                │
               └────────────────────────────────────────────────────────┘

    ┌──────────────────────────┐                          ┌──────────────────────────┐
    │    Google Antigravity    │                          │       OpenAI Codex       │
    │  - brain/transcript.jsonl│                          │  - sessions/*.jsonl      │
    │  - summaries.db (SQLite) │                          │  - state_5.sqlite        │
    └─────────────┬────────────┘                          └────────────┬─────────────┘
                  │                                                    │
                  ▼                                                    ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 1. Collectors & Watchers (ActivityTracker & Chokidar Engine)                  │
    │    - Discovers active project sessions across the machine in milliseconds      │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 2. Distillation & Noise Filtration (cleaner.ts)                                │
    │    - Strips <environment_context>, <USER_REQUEST>, and system prompts         │
    │    - Filters out `ls`, `cat`, `grep`, and ephemeral shell traces               │
    │    - Distills high-signal intent, decisions, and failed paths                 │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 3. Dual Injection & Mirroring Engine                                           │
    │    ├─ Channel A (Native Thread Mirror):                                        │
    │    │   ├─ Codex: Uses official `thread/start` + `thread/inject_items` RPC      │
    │    │   └─ Antigravity: Native `transcript.jsonl` + `conversation_summaries.db` │
    │    └─ Channel B (HANDOFF.md & MCP stdio):                                      │
    │        ├─ Updates `.amux/HANDOFF.md` on 3-second debounce                      │
    │        └─ Exposes MCP stdio tools to both agents                               │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 4. CLI & Daemon Layer                                                          │
    │    - `amux mirror`   : One-click thread replication                            │
    │    - `amux daemon`   : Headless background supervisor for continuous sync      │
    │    - `amux projects` : Bi-directional project alignment                        │
    └────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quickstart

### Prerequisites
- macOS (Linux / Windows support coming soon)
- Node.js >= 20.0.0
- OpenAI Codex Desktop & Google Antigravity installed

### Installation

```bash
# Clone the repository
git clone https://github.com/study8677/amux.git
cd amux

# Install dependencies and build
npm install
npm run build

# Link CLI globally
npm link
```

### 1. One-Click Setup
Configure global rule references (`~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`) and register the amux MCP server:
```bash
amux setup
```

### 2. Align Projects Across Agents
Preview or perform full two-way project synchronization:
```bash
# Preview what projects will be aligned
amux projects sync

# Apply alignment (automatically backs up existing configs before write)
amux projects sync --yes
```

### 3. Clone / Mirror a Conversation Instantly
Finished a conversation in Antigravity and want to continue in Codex (or vice-versa)?
```bash
amux mirror
```
*Output:*
```text
amux mirror · Analyzing workspace: ~/Documents/project2/amux
✔ Mirroring successful! Injected into OpenAI Codex
  · Thread Title: [From Antigravity] Implement bi-directional mirror
  · Turns Distilled: 14 turns (stripped tool execution noise)
  · Thread ID: 01a1c46b-1acb-71a3-866b-3448f7a0a486
  👉 Open Codex Desktop — the session is ready in your sidebar!
```

### 4. Run the Background Daemon (Zero-Touch Handoff)
Start the background daemon so that every conversation is automatically synced within 3 seconds of going idle:
```bash
# Start background daemon
amux daemon start

# Check status
amux daemon status

# View live sync activity
amux daemon log
```

---

## 💻 CLI Command Reference

```bash
amux mirror               # Clone the latest conversation to the counterpart agent
amux projects list        # List project pairings across Codex & Antigravity
amux projects sync --yes  # Synchronize project lists bidirectionally
amux watch                # Live terminal monitoring panel for the current repo
amux sync                 # Force immediate HANDOFF.md refresh
amux status               # Show current project's HandoffState summary
amux daemon start|stop    # Manage the background daemon
amux mcp                  # Run the Model Context Protocol stdio server
```

---

## 🛡 Safety & Reliability First

1. **Non-Invasive Protocol Calls**: amux uses Codex's official internal `app-server` JSON-RPC interface for creating and injecting threads. It never performs raw writes to Codex's master SQLite database while the app is active.
2. **Automatic Snapshots**: Any modification to project definitions creates a timestamped backup in `~/.amux/backups/`.
3. **Delete Circuit Breaker**: If an automated sync detects that more than 30% of projects are slated for deletion, it pauses and demands explicit user confirmation.
4. **Git Safe**: Automatically adds `.amux/` to `.git/info/exclude` to prevent polluting repository git logs.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. Check out our [Contributing Guide](CONTRIBUTING.md) for details on setting up the local development environment.

---

## 📄 License

MIT © [study8677](https://github.com/study8677)
