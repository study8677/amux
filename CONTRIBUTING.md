# Contributing to amux

Thank you for your interest in contributing to **amux**! Our goal is to eliminate agent amnesia and create a frictionless multi-agent coding experience.

## Development Setup

```bash
# 1. Clone repository
git clone https://github.com/study8677/amux.git
cd amux

# 2. Install dependencies (Node >= 20 required)
npm install

# 3. Run typecheck and tests
npm run typecheck
npm test

# 4. Build TypeScript bundle
npm run build

# 5. Link local binary for development
npm link
```

## Adding a New Harness Adapter

Want to add support for another AI coding tool (e.g. Claude Code, Cursor, OpenCode, Aider)?

1. Create a new directory in `src/harness/<your-tool>/`.
2. Implement the `HarnessAdapter` interface defined in [`src/harness/types.ts`](src/harness/types.ts):
   - `id`: Unique identifier (e.g. `'claude-code'`).
   - `displayName`: Human-readable name.
   - `detect()`: Check if the tool is installed and running on the user's machine.
   - `listSessions()`: Discover active or historical session logs/databases.
   - `collect()`: Extract new conversation turns and events using cursors.
   - `projects` (optional): Read and mirror project workspace lists.
3. Register your adapter in [`src/harness/registry.ts`](src/harness/registry.ts).
4. Add unit and integration tests in `test/harness/`.
5. Submit a pull request!

## Code Style & Safety Guidelines

- **Strict Read-Only for External DBs**: Never acquire write locks on foreign agent databases. Always use `readonly: true` or `file:...&immutable=1`.
- **Atomic Operations**: All write operations modifying workspace configurations must be atomic and preceded by automatic backups.
- **TypeScript**: No `any` without documented reason. Keep strict mode clean.
