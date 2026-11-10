# amux Architecture & Design Specification

## 1. Overview
`amux` (Agent Multiplexer) is a developer-focused CLI & background daemon designed to bridge OpenAI Codex and Google Antigravity. It enables seamless bi-directional conversation mirroring and project synchronization across local development workspaces.

---

## 2. Core Pillars

### 2.1 Clean Context Extraction & Filtration (`src/mirror/cleaner.ts`)
- **Noise Stripping**: Removes raw system prompt wrappers, environment tags (`<environment_context>`, `<USER_REQUEST>`, etc.), and transient agent metadata.
- **Tool Call Demarcation**: Filters out low-signal exploratory terminal commands (`ls`, `cat`, `pwd`, `grep`) while keeping user intents and agent synthesized solutions.
- **Role Continuity**: Normalizes and collapses contiguous user/assistant messages to build natural chat sequences.

### 2.2 Bi-directional Native Mirroring (`src/mirror/`)
- **To Codex (`to-codex.ts`)**:
  - Leverages Codex Desktop's built-in `codex app-server` via JSON-RPC.
  - Calls `thread/start` bound to target project's `cwd`.
  - Injects clean messages with `thread/inject_items`.
  - Sets thread title with `thread/name/set`.
- **To Antigravity (`to-antigravity.ts`)**:
  - Generates isolated brain workspace under `~/.gemini/antigravity/brain/<uuid>`.
  - Writes native `transcript.jsonl` containing normalized `USER_INPUT` and `PLANNER_RESPONSE` entries.
  - Registers record directly into `conversation_summaries.db`.

### 2.3 Bi-directional Project Alignment (`src/projects/`)
- Matches workspaces across harnesses via canonical normalized filesystem paths.
- Provides a clean functional reconciler with snapshot rollback capabilities and delete circuit-breaker protection.

---

## 3. Data Flow Diagram

```text
  [Antigravity Session]                    [Codex Session]
   (transcript.jsonl)                     (rollout-*.jsonl)
           │                                      │
           ▼                                      ▼
   ┌─────────────────────────────────────────────────────┐
   │        amux Context Cleaner & Normalizer            │
   │  - Strips environment tags & system prompts         │
   │  - Filters out shell exploration noise (ls, cat)    │
   └──────────────────────────┬──────────────────────────┘
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
    [To Codex via app-server]     [To Antigravity via brain]
       - thread/start                 - transcript.jsonl
       - thread/inject_items          - summaries.db
```
