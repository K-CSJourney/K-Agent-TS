# KAgent

A hands-on coding agent built from scratch in TypeScript — streaming LLM chat, a tool-calling loop, a permissioned file/shell toolset, long-term memory, a RAG knowledge base, skills, MCP servers, and a plugin system — all wrapped in a terminal UI (or a browser UI).

The point of this project is to build every layer an agent needs *by hand*, understanding each piece instead of gluing frameworks together.

## Features

- **Streaming chat with tool calls** — incremental SSE-style output, an agentic loop that lets the model chain tools across turns (with a hard round cap), and automatic context compaction when history grows too long.
- **A permissioned toolset** — every tool runs under an `allow / ask / deny` policy; `ask` tools show you exactly what will happen (diffs, shell commands, URLs) before executing. File tools are sandboxed to the project root, including symlink-escape protection.
- **Long-term memory** — entries are chunked into overlapping windows and retrieved with a zero-dependency BM25 scorer (Chinese bigram + English word tokenization). Relevant memories are recalled into the system prompt automatically as you type.
- **RAG knowledge base** — ingest web pages or local files into `.kagent/rag/`, then search them with the same BM25 ranking. Web ingestion reuses the hardened fetch pipeline: manual redirect following with per-hop confirmation, byte-capped streaming reads, charset-aware decoding.
- **Skills** — drop a folder with a `SKILL.md` into `src/skills/` to teach the agent a focused role. A skill can constrain the model to a whitelist of tools, and the whitelist is enforced at the execution layer, not just in the prompt.
- **MCP servers** — connect stdio MCP servers from `.kagent/mcp.json`; their tools show up as first-class tools with `mcp_` prefixes.
- **Plugins** — drop a folder with a `plugin.ts` into `src/plugins/` to register commands and tools, or run a service. Ships with a **web plugin** that exposes the agent as a local SSE chat app.
- **Sessions & undo** — named conversation sessions saved to disk, plus `/undo` for the last `write`/`patch`.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ (full-icu build, which is the default)
- [pnpm](https://pnpm.io/) 11+

### Setup

```bash
pnpm install

# configure your model provider (any OpenAI-compatible endpoint works)
cp .env.example .env
# then fill in:
#   OPENAI_BASE_URL=...
#   OPENAI_API_KEY=...
#   OPENAI_MODEL=...        e.g. qwen-plus
#   KAGENT_MAX_HISTORY=4000 # optional: history size (chars) before auto-compaction
```

### Run

```bash
pnpm run dev        # terminal UI mode (default)
pnpm run dev web    # web UI mode → http://localhost:8787
```

The first run creates `.kagent/` with a default permission config. Then just talk to it:

```
You > 帮我看看 src 下有哪些工具，并用 read 读一下 tools.ts 的开头
```

## Commands

| Command | Description |
| --- | --- |
| `/help` | Show help |
| `/compact` | Compress old history into a summary now |
| `/undo` | Undo the last `write` / `patch` |
| `/todos` | Show the agent's current TODO list |
| `/memory` | Show long-term memories |
| `/mcp` | Show connected MCP servers and their tools |
| `/rag add <url-or-path>` | Ingest a web page or local file into the knowledge base; `/rag` shows stats |
| `/skills`, `/use <name>`, `/unuse` | List / load / unload skills |
| `/plugins` | List loaded plugins |
| `/save`, `/load` | Save / load all sessions (`​.kagent/sessions.json`) |
| `/new <id>`, `/open <id>`, `/sessions` | Create, switch, list sessions |
| `/reset` | Clear current conversation history (memories are kept) |
| `/exit` | Save sessions and quit (also Ctrl+C / Ctrl+D) |

## Built-in Tools

| Tool | Policy | Description |
| --- | --- | --- |
| `get_current_time` | allow | Current local time |
| `ls` / `glob` / `read` / `search` | allow | Read-only directory listing, globbing, file reading (with `offset` paging), and content search |
| `fetch` | ask | Fetch a web page as plain text; redirects are re-confirmed per hop, responses are size-capped and charset-decoded, long pages support `offset` paging |
| `run_shell` | ask | Run a shell command (with confirmation and timeout) |
| `write` / `patch` | ask | Write or patch files after showing a diff; every change is backed up for `/undo` |
| `memory_write` / `memory_search` | allow | Long-term memory |
| `rag_add` / `rag_search` | ask / allow | Knowledge base ingestion and retrieval |
| `todo_write` / `delegate_task` | allow | Task planning and sub-agent delegation |

Plus whatever your MCP servers and plugins register.

## Permissions

Policies live in `.kagent/KAgent.json`:

```json
{
  "root": "..",
  "tools": {
    "run_shell": "ask",
    "write": "ask",
    "fetch": "ask",
    "memory_write": "allow"
  }
}
```

- `allow` — runs without asking
- `ask` — prompts before every execution (showing the diff / command / URL)
- `deny` — always rejected

`root` is the sandbox boundary for all file tools: paths outside it are rejected, and symlinks that resolve outside are refused too.

## Skills

Create `src/skills/<name>/SKILL.md`:

```markdown
---
description: 只读助手：只浏览代码与目录，不改动任何文件
tools:
    - ls
    - glob
    - read
    - search
---

你是只读代码浏览助手。……
```

Load it with `/use <name>`. The `tools` whitelist is enforced for real: while the skill is active, `execTool` rejects anything outside the list even if the model tries. A skill can also ship its own tools in an optional `tools.ts` next to `SKILL.md`.

## MCP Servers

Create `.kagent/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Servers start in parallel at launch; a failing server is reported but never blocks the agent. Their tools appear to the model as `mcp_<server>_<tool>`.

## Plugins

Create `src/plugins/<name>/plugin.ts`:

```ts
import type { Plugin } from "../../plugin-sdk";

const plugin: Plugin = {
    name: "echo",
    description: "Echo demo",
    commands: [{ name: "echo", description: "Repeat text", handler: (args) => `回声：${args}` }],
    onStart: async (ctx) => {
        ctx.registerTool({
            name: "echo_repeat",
            description: "Repeat a text n times",
            parameters: { type: "object", properties: { text: { type: "string" }, times: { type: "number" } }, required: ["text", "times"] },
            run: (args) => Array(Number(args.times) || 1).fill(String(args.text)).join(" "),
        });
    },
};

export default plugin;
```

Plugins get a runtime context with output helpers, the chat entry points, tool registration (auto-rolled-back if `onStart` fails), and optional `onExit` cleanup.

## Project Structure

```
src/
├── index.ts          # entry point: mode selection, wiring, commands
├── chat.ts           # streaming chat, tool-call loop, history compaction
├── tools.ts          # tool registry + built-in tools + shared fetch core
├── permissions.ts    # allow/ask/deny policies, path sandbox, secret redaction
├── memory.ts         # chunked long-term memory + BM25 retrieval
├── rag.ts            # knowledge base (ingest + search)
├── skills.ts         # SKILL.md loader, tool whitelists
├── skills/           # explore / code-review
├── mcp.ts            # stdio MCP client
├── plugin.ts         # plugin loader, commands, rollback
├── plugins/          # echo / web (SSE chat UI)
├── sessions.ts       # named conversation sessions
├── todos.ts          # agent TODO list
├── tui.ts            # terminal UI (pi-tui based, with a status panel)
├── color.ts          # terminal coloring (auto-off when not a TTY)
├── storage.ts        # session persistence
├── instructions.ts   # AGENTS.md project instructions
└── undo.ts           # write/patch backups
```

## Notes

- All state lives under `.kagent/` (permissions, sessions, memory, knowledge base, MCP config), which is gitignored.
- The agent never sends your environment variables to the model — known secret-like values are redacted from tool output.
- This project is intentionally framework-free: the tool loop, retrieval, sandbox, MCP client, and plugin system are all hand-rolled for learning purposes.

## License

[ISC](https://opensource.org/licenses/ISC)
