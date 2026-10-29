# AgentsCircle 1.3

One chat, many coding agents. Create a session for a project folder, add the agents you use, and talk to them like a group chat:

```
@codex look through the auth code and list what's broken
@claude fix the first two issues codex found, using your design skill for the login screen
@all review the last change
```

Every agent sees the whole conversation plus the project's git state, and they all work in the same folder, so nobody needs the context pasted in again.

## Install

**Desktop app (recommended):** download the installer for Mac (.dmg) or Windows (.exe) from the Releases page and open it. On first launch AgentsCircle checks which agents you have, installs and signs in the missing ones with their official installers, and asks for your first project folder. It updates itself (Settings → About; choose Stable or Beta).

**From source / terminal:** needs Node.js 22+.
```bash
npm install
npm run app     # the desktop app
npm start       # or: run in your browser at http://localhost:4317
```

Your data (sessions, accounts, connectors, skills, logs) lives in `~/.agentscircle`, shared by both ways of running, and is never touched by updates. If you used the app under its old name, AgentsCircle copies your accounts and sessions from `~/.agentroom` on first start (the old folder is left as it was). See RELEASING.md to publish your own builds.

## Look and layout (v1.3)

A full redesign: a new logo and app icon, an icon set drawn for the app, motion on messages, dialogs, the panel and the board, and six themes (Graphite, Midnight, Obsidian; Daylight, Mist, Paper) plus Auto. Settings → Appearance also sets the layout: sidebar left or right, panel right or bottom, compact or comfortable density, chat width and font size. The session panel opens on the **Board**: every turn is a strip in a bay (Needs you, Working, Up next, Done) and moves when its state changes. The design system is written down in DESIGN.md.

## Using it

- **New session:** paste the project folder's full path, tick the agents, optionally paste a summary from another chat (Claude Desktop, ChatGPT…) so everyone starts with that context.
- **@mention** an agent to give it a task. `@all` asks everyone, one after another.
- **No mention** goes to the default agent (★). Double-click an agent chip to change it.
- **Agent chips** at the top: click to add or remove an agent from the session.
- Agents take turns (one at a time) so they don't overwrite each other's edits. **Stop** cancels the current one and the queue.
- Under each reply you'll see the tools the agent used and the files it changed.
- **Export** downloads the whole session as Markdown.
- **Theme:** Light, Dark or Auto (follows your Mac or Windows setting), at the bottom of the sidebar.

### Session panel (right side, like the Claude desktop app)

- **Progress:** who is working right now, the current step, a live timer, the agent's task list with a progress bar, who's up next, and a timeline of every turn (click one to jump to it).
- **Files:** everything agents created or changed in this session, with a live **Preview** (web pages, images, Markdown, PDFs), **Changes** (the git diff) and **Source**. Reveal or Open a file on your computer. Commits made by agents are listed too. File chips under each reply open the same preview.
- **Used:** turns, agent time, files, tokens and cost; a row per agent (account, model, connectors it has); skills used, connectors used (for example Lovable › create_project), sub-agents and a tool breakdown.

Claude Code, Codex and Cursor report their tools, task lists and token usage (cost only from Claude Code). OpenCode runs in JSON mode too (its event format changes between versions, so its details are best effort).

Sessions are saved in `~/.agentscircle/sessions`.

## Session context, editing and the panel (v1.3.2)

- **Session context:** give a session notes, requirements, files and images (designs, screenshots, specs) that every agent gets with each task. Add it in **New session**, or later with **Context** in the session header. You can paste or drop files and images. Files are copied into `.agentscircle/context/<session>` in the project folder and kept out of git.
- **Rename and delete sessions:** hover a session in the sidebar and click **…**, or right-click it. You can also use the **…** button at the top right of an open session. Deleting removes the conversation and its context files from AgentsCircle; your project folder isn't touched. ⌘⌫ (Ctrl+Backspace) deletes the open session after asking.
- **Resizable panel:** drag the panel's edge to make it wider (or taller when it sits below the chat). Double-click the edge or use the expand button to give it as much room as the chat allows; click again to go back. The size is remembered.
- **Edit files in the panel:** open a file from the Files tab, a file chip or an attachment, and use **Edit**. It has line numbers, Tab and Shift+Tab indenting, and keeps your indentation on new lines. Save with ⌘S (Ctrl+S). Unsaved edits stay while you move around the panel. If an agent changed the file after you opened it, AgentsCircle asks before overwriting. Every save adds a note to the chat, so the next agent knows you changed the file.

## Model and effort per agent, per session (v1.3.4)

Click an agent's chip at the top of a session to choose its **model** and **effort** for that session. Change them any time; the next turn uses them, and every session keeps its own choice. The chip shows what's set (for example `@codex gpt-6-astra · high`), and every reply shows the model and effort it used.

- **Claude Code:** Fable, Opus, Sonnet or Haiku (or any model name), effort low to max.
- **Codex:** the models in your Codex's own list, each with the effort levels it supports.
- **Cursor and OpenCode:** the models their `models` command lists.
- **Usual** means the account's default (Settings → Agents and accounts → Edit), or the tool's own default.

The same menu makes an agent the session's default or removes it from the session.

## Accounts that really work (v1.3.4)

An account is only marked **working** after AgentsCircle runs it once for real (a one-word reply), not just because its files name an email. This happens when you add an account, when you click **Check**, during first-run setup, and in the background when the app starts (accounts that failed, or weren't checked for a day).

- **Signed out?** The account shows **signed out** in Settings and a red dot on its chip. **Log in** opens the sign-in page (Anthropic or OpenAI) in your browser, with no Terminal: AgentsCircle runs the tool's own sign-in in the background, takes the code if the page shows one, and checks the account works (v1.3.5).
- **Codex model your plan can't use?** If OpenAI refuses Codex's default model for your plan (for example when the Codex app and the `codex` command are different versions), AgentsCircle picks the first model in Codex's own list that your account accepts, remembers it, and reruns the message. You can set the model yourself under Edit.

## Continue a conversation from Claude Code or Codex (v1.1)

Started something in Claude Code or Codex in a terminal? In **New session**, pick the project folder and AgentsCircle lists the conversations you had there (from every Claude Code and Codex account it knows). Click one, create the session, and its messages are added to the chat, so every agent can continue from it. In an open session, **Bring in a chat** does the same. Only the text between you and the agent is brought in, not tool output. Long conversations are summarized automatically before the next turn.

## Circle tools (v1.1)

Every agent that can use connectors (Claude Code, Codex, Cursor, OpenCode) gets AgentsCircle's own connector with four tools:

- **read_thread** reads older messages or searches the chat.
- **list_agents** shows who is in the circle, which account each uses, whether it's busy, and its skills and connectors.
- **mention** hands a task to another agent (respects the Hand-offs switch and the limit of 4 in a row).
- **ask_user** shows a question card in the chat, with options, and waits for your answer.

Each run gets its own key, valid only while it runs, and the connector only talks to AgentsCircle on your computer. Tools without connector support still hand off with `@codex: task` lines.

## Switching accounts when one runs out (v1.1)

When an account hits its usage limit, AgentsCircle reruns the same message on another account of the same tool (one already in the circle first, otherwise it adds one) and notes it in the chat. The limited account rests until its reset time, read from the error when the tool gives it (otherwise one hour); mentions of it go to a spare in the meantime. Turn it off in Settings → Agents and accounts.

## Needs you (v1.2)

When an agent asks a question or waits for your OK in any session, a red **Needs you** button appears at the top of the sidebar, the session gets a red dot, and the Dock icon shows a badge (macOS; on Windows the taskbar button flashes). Click the button to see everything waiting and jump to it. You also get a system notification and a short chime; finished turns notify you only when you're in another app or session. Choose what notifies you in Settings → Appearance → Notifications.

## Usage meters (v1.2)

Settings → Agents and accounts, and the **Used** tab of the session panel, show how much each account has used, read from the files the tools already write on your computer:

- **Codex:** your plan's real limits, as Codex records them: % of the 5-hour and weekly windows used, and when each resets.
- **Claude Code:** tokens in the current 5-hour window (and when it resets) and in the last 7 days. Claude Code doesn't record your plan's percentage, and this counts only this computer.

## Review and commit per agent (v1.2)

In the **Files** tab, filter by agent (All · @claude · @codex…) and click **Commit @claude's changes**: only the files that agent changed in this session are committed, with a message suggested from its last status. A file that two agents changed is committed whole (the tab warns you). Committed files are marked in the list.

## Status lines and the losing-track warning (v1.2)

Every agent ends its reply with a one-line **Status**, shown under the reply. If an agent skips it twice in a row, that usually means it has stopped following its instructions because the conversation is too long. AgentsCircle warns you and offers **Summarize now**, which gives every agent a shorter, clearer context.

## Secrets in your keychain (v1.2)

In the desktop app, account API keys and connector tokens are encrypted with your system keychain (macOS Keychain, Windows Credential Manager) and kept in `~/.agentscircle/secrets.json`; the key that unlocks them never leaves the keychain. Keys saved by earlier versions are moved there on first start. When you run `npm start` in a terminal instead, the keychain isn't available: new secrets are kept in owner-only files as before, and secrets already in the keychain are shown as locked until you open the app.

## Skills and connectors

AgentsCircle launches each agent's own CLI, so each one uses **its own** skills, MCP connectors and login:

- `@claude` uses whatever Claude Code has (`~/.claude/skills`, `claude mcp list`). Skills and connectors from the Claude desktop/web app need to be added to Claude Code separately.
- `@codex` uses its own config (`~/.codex/config.toml`), e.g. a Lovable MCP server.
- `@cursor` uses `.cursor/mcp.json`.

For skills every agent should share, put them in the project (for example a `skills/` folder) and mention them in `CLAUDE.md` / `AGENTS.md`.

## Several accounts of the same tool

Open **Agents and accounts** (sidebar, or the **+ account** chip).

1. Pick the tool (Claude Code, Codex, Cursor…), choose a handle like `claude-work`, an optional label (Work, Personal) and a color.
2. Keep **Separate login** ticked. AgentsCircle creates a login folder just for this account in `~/.agentscircle/accounts/<handle>` and opens a Terminal window to sign in.
3. Click **Check** after signing in. The row and the chips then show which email the handle is signed in as.

Every reply shows its handle and account, so you always know who answered. If an account hits its usage limit, its chip turns amber and the reply suggests another account of the same tool.

How it works: Claude Code reads `CLAUDE_CONFIG_DIR` and Codex reads `CODEX_HOME`, so each handle points the tool at its own folder. For a second Cursor account, paste that account's API key instead. Removing a handle keeps its login folder, so adding it back doesn't need a new login.

Your accounts are saved in `~/.agentscircle/agents.json` (readable only by you).

## Parallel work (v0.5)

The **Mode** button in the session header switches between:

- **Shared folder** (default): agents take turns in your folder.
- **Parallel**: each agent gets its own copy of the project (a git worktree on its own branch, starting from your folder as it is, uncommitted files included). Agents mentioned together, like `@claude @codex both try this`, work **at the same time**. Your folder doesn't change until you apply a branch.

The side panel's **Branches** tab shows each agent's branch:
- **Compare:** a table of which files each agent changed; files changed by more than one agent are highlighted.
- **Review:** everything that branch changed.
- **Apply to my folder:** brings the changes into your folder with a line-by-line three-way merge per file. Clashes are marked with `<<<<<<< yours` / `>>>>>>> @agent`, and the chat says which files need a look. Each apply can be undone from the chat like an agent turn. Nothing is committed and your git branch and staging area aren't touched.
- **Discard:** removes the branch and its copy; the agent's next turn starts fresh from your folder.
- **Ask an agent to combine them:** fills in a message asking one agent to merge the best of each branch.

Worktrees live in `~/.agentscircle/worktrees/`. Ignored folders such as `node_modules` aren't copied, so agents install dependencies in their copy if they need to run the project.

## Working together (v0.4)

- **Hand-offs.** An agent can pass work to another by ending its reply with a line like `@codex: write tests for the login form`. The hand-off shows in the chat and the next agent starts with the full context. After 4 hand-offs in a row AgentsCircle pauses the chain and waits for you. Turn it off per session with the **Hand-offs** button.
- **Long sessions stay sharp.** When a session outgrows what fits in an agent's prompt, AgentsCircle asks one of your agents (Claude Code if it's in the session) to write a summary of the older part, read-only. Agents then get the summary plus the recent messages. You can also click **Summarize now** in the Progress tab. The summary appears in the chat so you can read it.
- **Attachments.** Click 📎, paste a screenshot, or drop files on the window. Files are saved in the project's `.agentscircle/uploads/` (kept out of git) so every agent can open them; Codex also receives images directly.
- **What each agent can use.** The panel's Used tab lists each agent's connectors and skills (its own and shared ones). If you ask an agent for something only another agent has, AgentsCircle tells you.
- **Shared skills** (Settings → Skills). Skill folders with a `SKILL.md` are told to every agent, which reads them when a task matches. Sources: your project's `skills/`, `.claude/skills/` or `.agentscircle/skills/`; skills shared for all projects (`~/.agentscircle/skills`); a skill `.zip` you upload; or one of an agent's own skills with **Share with all agents**.
- **Search** every session from the box at the top of the sidebar.
- **Codex in JSON mode.** The panel now shows Codex's commands, file changes, connector calls, task list and tokens.

## Shared connectors

**Settings → Connectors.** Add a connector (MCP server) once and every agent gets it, the same way Claude Code and Codex add connectors, but shared:

- **Popular:** one-click entries for Lovable, GitHub, Supabase, Vercel, Stripe, Notion, Linear, Figma, Sentry, Hugging Face, Zapier, Context7, DeepWiki and Playwright.
- **Search registry:** the official MCP Registry, with thousands of connectors from their makers.
- **From my agents:** import connectors you already set up in Claude Code, Codex or Cursor, so the other agents get them too.
- **Custom:** a remote URL (with sign-in, a token, or none) or a command that runs on your computer.

Each connector has **Test** (checks it answers and lists its tools), an on/off switch, and a choice of which agents get it. Connectors that use sign-in (OAuth) need one sign-in per agent: click **Sign in**, pick the agent, and finish in the browser.

How it reaches each agent, without editing their own settings:
- **Claude Code:** an extra `--mcp-config` file per run, and the shared connectors' tools are pre-approved (runs here can't show "allow?" prompts). Tokens are passed through environment variables, not written to the file.
- **Codex:** `-c mcp_servers.<name>…` settings on the command line; tokens through `bearer_token_env_var`.
- **Cursor:** added to the project's `.cursor/mcp.json` for the run (with `--approve-mcps`), then the file is put back exactly as it was. Tokens are read from environment variables.
- **OpenCode:** passed through `OPENCODE_CONFIG_CONTENT`, which OpenCode layers on top of its own settings.

Connectors and tokens are saved in `~/.agentscircle/connectors.json`, readable only by you. In the session panel's **Used** tab, ⇄ marks connectors that came from AgentsCircle.

## Tools config (`tools.json`)

How each tool is launched: a command plus arguments. Edit it to change permission levels or models, then restart.

- `{PROMPT}` is replaced by the full prompt; `"stdin": true` pipes the prompt in instead (better for long sessions, and required on Windows for big prompts).
- `"parser"`: `"claude-stream"` for Claude Code / Cursor stream-json output, `"text"` for plain output.
- `"configEnv"`: the variable that gives an account its own login folder.
- **Mock agent** for testing without credits: start with `AGENTSCIRCLE_DEV=1 npm start`, then add an account with the Mock tool.

## Safety: permissions, approvals, undo

**Permission level per agent** (Settings → Agents and accounts):

| Level | Claude Code | Codex | Cursor |
|---|---|---|---|
| Read only | Can't edit; commands that change things are blocked | `--sandbox read-only` | `--mode ask` |
| Ask before risky actions (default) | Edits freely; risky actions wait for your OK in the chat | `--sandbox workspace-write` | `--force` |
| Ask before every command | Edits freely; every command and connector action waits for your OK | `--sandbox workspace-write` | `--force` |
| Full auto | Never asks | `--sandbox danger-full-access` | `--force` |

Only Claude Code can ask you mid-turn (through AgentsCircle's approval connector, `--permission-prompt-tool`). Codex and Cursor can't pause for a question in this mode, so their levels map to their own sandbox settings.

**Risky actions** include `git push`, `git reset --hard`, `rm`, `sudo`, deploys and publishes, database pushes and drops, and connector actions that send, delete, deploy, execute or pay. Reading files and safe commands (`ls`, `git status`, `git diff`…) never ask.

**Approve / Deny cards** appear inside the agent's reply: Allow once, Allow for this session (stops asking for that kind of action from that agent), or Deny with an optional note the agent will see. The status bar and the browser tab title show when something is waiting. Unanswered requests are denied after 30 minutes.

**Checkpoints and Undo.** Before and after every turn AgentsCircle takes a snapshot of the project, stored as hidden git refs (`refs/agentscircle/…`); your branch, staging area and history are never touched. Each reply with changes gets:
- **Review changes:** the exact diff of that turn, in the side panel.
- **Undo this turn:** puts back the files that turn changed (and removes files it created). AgentsCircle warns you if later turns also changed those files. **Bring back** reverses the undo.

Undo needs git in the folder; for folders without it, AgentsCircle offers to run `git init` (nothing is committed).

**Limits per agent:** a time limit per turn (default 30 minutes) and, for Claude Code, a spending limit per turn (`--max-budget-usd`).

## Known limits in 1.3

- In Parallel mode, a hand-off goes to the other agent's own branch; it sees the conversation but not the first agent's files until you apply them.
- A conversation brought in from Claude Code or Codex becomes shared context; the agent doesn't resume its own CLI session (the original stays in Claude Code / Codex, where `claude --resume` or `codex resume` still works).
- Account switching recognizes the usual Claude Code and Codex limit messages; a tool that words its limit differently is treated as an ordinary error.
- In Cursor, the circle tools are added to the project's `.cursor/mcp.json` for the length of a turn and removed afterwards.
- Usage meters: Claude Code's are token counts from this computer, not your plan's percentage; Codex's percentages are as of the last Codex turn on this computer.
- Notifications need the app to be running (a turn that finishes after you quit won't notify you).

## License

AgentsCircle is source-available under the [Functional Source License 1.1, Apache 2.0 future license](LICENSE.md) (FSL-1.1-ALv2).

- You can use, read, change and share it for anything except building a competing product or service: use it at work, run it for your team, learn from it, fix it.
- Each release becomes Apache 2.0, a standard open-source license, two years after it is published.
- "AgentsCircle" and its logo are trademarks of ORBITA FOR COMPUTER PROGRAMMING LLC and are not covered by the license.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
