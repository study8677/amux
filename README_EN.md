<div align="center">

# ⚡ amux (Agent Multiplexer)

**The `tmux` for AI Coding Agents. Native thread mirroring & bi-directional project sync between OpenAI Codex and Google Antigravity.**

[![GitHub Stars](https://img.shields.io/github/stars/study8677/amux?style=for-the-badge&logo=github&color=gold)](https://github.com/study8677/amux/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-orange.svg?style=for-the-badge)](https://github.com/study8677/amux/pulls)

**[简体中文](README.md)** · **[English](README_EN.md)** · **[Architecture Spec](docs/architecture.md)**

</div>

---

## 💡 Why amux?

If you frequently juggle between **OpenAI Codex** and **Google Antigravity** during development, you've definitely hit these roadblocks:

- **Split Threads**: You were having an insightful conversation in Antigravity. When you open Codex Desktop, the sidebar is blank. You have to re-explain everything or switch back and forth.
- **Tool Noise & Pollution**: Raw logs contain dozens of exploratory shell calls (`ls`, `cat`, `pwd`), stack traces, and system prompts that waste tokens and confuse the other agent.
- **Project Desync**: Creating or renaming a project on one tool requires repetitive manual setup on the other.

**`amux` solves this with zero friction**:
> When you finish chatting with one agent and open the other, **the entire conversation is already rendered in the sidebar as native message bubbles**. Just click and continue typing!

---

## 🌟 Core Superpowers

### 🔄 1. Bi-directional Native Thread Mirroring (Zero Tool Noise)
- In Antigravity discussing code? Switch to Codex Desktop and find the **entire conversation already waiting for you in the sidebar**!
- **Intelligent Noise Filter**: Strips out noisy exploration commands (`ls`, `cat`, `pwd`), internal trace stacks, and system tags. Keeps only human intent and agent conclusions.
- **Safe & Native**: Integrates cleanly through Codex's official `app-server` JSON-RPC protocol (`thread/start` + `thread/inject_items`). Never tampers directly with fragile SQLite databases.

### 🗂 2. Bi-directional Project Alignment
- Discovers project roots across Codex and Antigravity.
- Real-time two-way synchronization for project creation, renaming, and deletion with automated pre-operation backups and a safety circuit breaker (pauses bulk deletions > 30%).

### ⚡ 3. Invisible Background Daemon
- Runs silently with near-zero CPU and memory footprint (< 40MB).
- Listens to active sessions and automatically replicates distilled conversations to the other agent after 3 seconds of inactivity.

---

## 🏗 Architecture Pipeline

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
    │    - Detects active sessions and project roots across the machine in ms        │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 2. Distillation & Noise Filtration (cleaner.ts)                                │
    │    - Strips <environment_context>, <USER_REQUEST>, and system prompts         │
    │    - Filters out `ls`, `cat`, `grep`, and ephemeral shell traces               │
    │    - Distills high-signal intent and clean agent conclusions                   │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 3. Native Thread Mirroring Engine                                              │
    │    ├─ Codex Injection       : Official `thread/start` + `thread/inject_items`  │
    │    └─ Antigravity Injection : Native `transcript.jsonl` + summaries.db update  │
    └───────────────────────────────────────┬────────────────────────────────────────┘
                                            │
                                            ▼
    ┌────────────────────────────────────────────────────────────────────────────────┐
    │ 4. CLI & Background Supervisor                                                 │
    │    - `amux mirror`   : One-click conversation replication                      │
    │    - `amux projects` : Bi-directional project alignment                        │
    │    - `amux daemon`   : Headless background supervisor for continuous sync      │
    └────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quickstart

### Prerequisites
- macOS (Linux / Windows support in progress)
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

### 1. Mirror a Conversation Instantly
Finished a conversation in Antigravity and want to continue in Codex (or vice-versa)?
```bash
amux mirror
```
*Output:*
```text
amux mirror · Analyzing workspace: ~/Documents/project2/amux
✔ Mirroring successful! Injected into OpenAI Codex
  · Thread Title: [From Antigravity] Optimize database queries
  · Turns Distilled: 16 turns (stripped tool execution noise)
  · Thread ID: 01a1c558-fd6f-7c20-b442-26bd55581d37
  👉 Open Codex Desktop — the session is ready in your sidebar!
```

### 2. Align Projects Across Agents
Preview or perform full two-way project synchronization:
```bash
# Preview what projects will be aligned
amux projects list

# Apply alignment (automatically backs up existing configs before write)
amux projects sync --yes
```

### 3. Run the Background Daemon (Zero-Touch Mirroring)
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
amux mirror               # Clone current conversation to counterpart agent
amux projects list        # List project pairings across Codex & Antigravity
amux projects sync --yes  # Synchronize project lists bidirectionally
amux daemon start|stop    # Manage background auto-mirroring daemon
amux daemon status        # Check daemon status
amux daemon log           # Tail daemon mirroring logs
```

---

## 🛡 Safety & Reliability First

1. **Non-Invasive Protocol Calls**: amux uses Codex's official internal `app-server` JSON-RPC interface for creating and injecting threads. It never performs raw writes to Codex's master SQLite database while the app is active.
2. **Automatic Snapshots**: Any modification to project definitions creates a timestamped backup in `~/.amux/backups/`.
3. **Delete Circuit Breaker**: If an automated sync detects that more than 30% of projects are slated for deletion, it pauses and demands explicit user confirmation.

---

## 📄 License

MIT © [study8677](https://github.com/study8677)
