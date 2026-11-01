# SKI app: what AgentsCircle can borrow

Source: `/Applications/SKI.app` v0.4.148 (binary `voiceharness`, arm64, Tauri + Rust). Static analysis only.

## How this was analysed
- REA opened the binary and read its Mach-O metadata. REA's disassembler needs Hopper, and macOS denied Automation permission, so there is **no decompilation or call-graph**.
- Everything below comes from strings embedded in the binary (tool schemas, system-prompt text, URLs, crate paths). Treat it as strong hints, not verified behaviour. Nothing was run.

## What SKI is
A voice assistant that sits above coding agents. It is "the ONE voice for all of the user's projects and sessions". It drives Claude, Codex, Gemini, Cursor, OpenCode and Pi over the Agent Client Protocol (ACP), and exposes its own MCP server (`ski`) to the agents.

## SKI's agent-facing tools (from its MCP server)
`ask`, `tasks`, `report`, `screenshot`, `loop`, `handoff`, `permit`, plus `read_tasks`, `stop_agent`, `switch_harness`, `send_claude`.

## Ideas, ranked by value for AgentsCircle

| # | Idea | What SKI does | Fit for AgentsCircle |
|---|------|---------------|----------------------|
| 1 | **Recurring tasks (`loop`)** | "When the user wants something done again and again (check the deploy every...)" | Schedule a message to an agent on an interval. We have no scheduler. |
| 2 | **Chains** | Messages say "you are a step of a chain (`ch-...`)": a fixed sequence of agents, each passing results on | Builds on our @mention handoffs: saved pipelines such as Cursor builds, Codex reviews, Claude fixes. |
| 3 | **Permission relay (`permit`)** | Agent calls `permit {tool_name, input, tool_use_id}`; the request is surfaced to the user and answered | We already ask approval. A single approvals inbox across all agents, with remote or phone answers, would be new. |
| 4 | **Structured `ask`** | Opens a choice prompt when the request is unclear | We have `ask_user`. SKI also supports multi-question forms and routes the answer back. |
| 5 | **Stop and resume** | `stop_agent` returns `last_message` (the agent's last words); `/v1/plan/resume`, `/v1/plan/cancel`, `checkpoint_revert` | Show "last words" when a turn is stopped, and offer resume or cancel. |
| 6 | **Screen awareness** | `screenshot` tool when the user says "this" or "here"; clear message if Screen Recording is off | Optional "look at my screen" button that attaches a capture. We only have manual attach. |
| 7 | **Per-agent install and login status** | Checks each CLI: installed, signed in, needs Node, update available, with an install or login hint and command | Setup screen that shows each agent's state and a one-click fix command. |
| 8 | **Model catalogue** | Pulls model lists from provider APIs, models.dev, OpenRouter, Ollama, LM Studio; supports Bedrock, Vertex, custom endpoints | Auto-populated model picker with context limits. Also local-model agents. |
| 9 | **ACP registry** | Reads `cdn.agentclientprotocol.com/registry`; supports Gemini and Pi via ACP adapters | Add agents through ACP instead of writing a custom adapter each time. |
| 10 | **PR creation** | Runs `gh`-style create with title, body file, base, head, draft; PR body says "Created with SKI" | One-click "open PR" from a finished worktree. |
| 11 | **Voice** | Hotkey, speech in and out, spoken short answers | Big feature; lower priority for a chat-first app. |
| 12 | **Safety rule** | System prompt: "Always ask before anything destructive"; never claim a request was sent before the answer arrives | Worth copying into our agent preamble. |

## Suggested first picks
1. Recurring tasks (#1): smallest scope, clear user value.
2. Saved chains (#2): reuses existing mention and turn-taking code.
3. Setup status screen (#7): reduces first-run failures.
4. Open PR from worktree (#10).

## Caveats
- Strings show intent, not working code. Features may be partial or behind flags.
- Not copied: no code or assets from SKI were extracted. Implement from the ideas only.
