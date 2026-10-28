# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Delivered as an Electron desktop app for macOS and Windows; the interface is a web page served locally. Also runs in a browser via `npm start`.)

## Users

Two audiences equally at launch:
- Solo developers who "vibe code": one person working on a project with several AI coding agents (Claude Code, Codex, Cursor, OpenCode) and often several accounts of the same tool.
- Small development teams that share circles and agents.

They use it both ways: open all day beside the editor and glanced at constantly, and as check-ins where they hand agents work, leave, and come back to review.

## Product Purpose

One group chat for all of a developer's AI coding agents. The developer @mentions any agent in a shared session tied to a project folder; every agent sees the same conversation and project state, so nobody re-pastes context when switching agents or accounts. Success: the developer moves work between agents without copy-paste, always knows who did what and what is waiting for them, and trusts what changed in the project.

## Positioning

The only product built around one shared thread where the user @mentions several agents from different vendors and accounts, with the agents themselves able to read the thread, hand work to each other and ask the user questions. The closest competitor (AgentsRoom) runs each agent in its own terminal pane with inbox-style messaging between them; AgentsCircle is chat-first and deliberately simpler.

## Operating Context

- Sessions are tied to a project folder (usually a git repository). Agents work in the shared folder in turn, or in parallel on their own git worktrees.
- Each reply shows what the agent did: activity, files changed, tools, skills and connectors used, tokens and cost, approvals and questions waiting for the user.
- A side panel shows progress, files (with previews, diffs, per-agent commit), what was used, and branches.
- Users switch between several sessions and come back to see what needs them (the Needs-you inbox, notifications, Dock badge).
- Settings cover agents and accounts, shared connectors (MCP), shared skills, appearance and notifications, about and updates.

## Capabilities and Constraints

- Electron desktop app; must work offline (no hosted fonts or CDN assets at runtime).
- Plain HTML, CSS and JavaScript in `public/` (no framework or build step); the server is Node/Express.
- Agent identity is carried by per-agent colors chosen by the user or the tool default.
- Light and dark themes plus Auto must stay. The user wants more theme choices and layout options in the spirit of Cursor and VS Code.
- Terminology: session (a circle), agent / account handle (@claude-work), connector, skill, hand-off, approval, question, checkpoint, branch.

## Brand Commitments

- Name: AgentsCircle. Domain: agentscircle.dev.
- No logo exists yet; one is needed.
- Must not feel: playful or cute, like a terminal, like a generic SaaS template, or flashy.
- Ambition stated by the user: polished as if a top-tier product company made it.

## Evidence on Hand

No customers, testimonials, metrics or press yet. Screens and features exist in code; nothing may claim usage numbers.

## Product Principles

1. One thread is the truth: context lives in the conversation, never copy-pasted.
2. Always show who: every reply, change and cost is attributed to a specific agent and account.
3. The user stays in control: approvals, questions, undo and per-agent commit before anything leaves their hands.
4. Calm by default, loud only when the user is needed.
5. Simple over exhaustive: fewer, clearer surfaces than terminal-heavy competitors.
