---
name: AgentsCircle
description: One chat for all your coding agents. A calm board where you see who holds which strip of work and which one waits for you.
colors:
  graphite-rail: "#0e1012"
  graphite-bg: "#121416"
  graphite-panel: "#17191c"
  graphite-raised: "#1c1f22"
  graphite-strip: "#1d2024"
  graphite-line: "#262a2e"
  graphite-text: "#e9ebed"
  graphite-muted: "#8a9198"
  graphite-faint: "#888d93"
  daylight-rail: "#ebedea"
  daylight-bg: "#f5f6f4"
  daylight-panel: "#ffffff"
  daylight-text: "#16191c"
  daylight-muted: "#5f666d"
  daylight-faint: "#63686d"
  signal: "#5cb8e4"
  signal-on: "#06141b"
  needs-you: "#f0a43a"
  done: "#4cc38a"
  error: "#ef6363"
  logo-sand: "#ebd9ae"
  logo-sky: "#8fb9e2"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.003em"
  callsign:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "14.5px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.015em"
  label:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.1em"
  wordmark:
    fontFamily: "Barlow Semi Condensed, Arial Narrow, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.005em"
  code:
    fontFamily: "ui-monospace, SF Mono, Cascadia Code, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "6px"
  md: "8px"
  card: "10px"
  strip: "14px"
  pill: "999px"
spacing:
  row: "32px"
  pad: "12px"
  sidebar: "264px"
  panel: "400px"
  chat: "800px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-on}"
    rounded: "{rounded.md}"
    height: "32px"
  reply-strip:
    backgroundColor: "{colors.graphite-panel}"
    textColor: "{colors.graphite-text}"
    rounded: "{rounded.strip}"
    padding: "12px 16px"
  board-strip:
    backgroundColor: "{colors.graphite-strip}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
  callsign-tile:
    rounded: "{rounded.sm}"
    size: "20px"
    typography: "{typography.label}"
  needs-you-button:
    textColor: "{colors.needs-you}"
    rounded: "{rounded.md}"
---

# AgentsCircle design

## Overview

The app is a flight-strip board. Every agent turn is a strip handed from one agent to the next; the app is the calm board where you see at a glance who holds which strip, which one is waiting for you, and who changed what. It is an Operate surface: open all day beside the editor, glanced at constantly, and used in check-ins. Ambition shows as precision and restraint, not decoration.

It refuses two defaults: the grey dashboard with one accent colour, and the terminal look. It must never feel playful, cute, flashy or like a template.

Source of truth: `public/app.css` (tokens and components), `public/look.js` (themes and layout options), `public/icons.js` (icon set), `public/logo.svg` and `build/icon.svg` (logo). The frontmatter above lists the Graphite (dark) and Daylight (light) values; the other four themes follow the same token names.

## Colors

- **Grounds:** graphite with a faint green tint in dark themes, daylight grey in light themes. The rail (sidebar) is the darkest/most recessed surface, then the page, then panels, then raised strips.
- **Signal cyan** is the only action colour: primary buttons, focus rings, the send button, links, progress. Nothing decorative is cyan.
- **Amber means "needs you"** and nothing else: questions, approvals, the Needs-you button, the red-dot rule's calmer sibling on waiting replies. If amber appears, the user has something to do.
- **Green** is done/added, **red** is error/deleted. Diff colours derive from these.
- **Agent identity** comes from each agent's own colour, used only on its callsign tile, handle and board strip, never as a surface.
- **Six themes:** Graphite, Midnight, Obsidian (high contrast) for dark; Daylight, Mist, Paper (high contrast) for light; plus Auto. Every theme defines every token; text colours pass WCAG AA (4.5:1) on every surface they sit on, checked by script.

## Typography

- **Body:** the platform UI face (SF Pro on Mac, Segoe UI Variable on Windows) at 13.5px/1.5, adjustable in Appearance. Native text keeps the app feeling like a Mac/Windows app, not a web page.
- **Callsigns and labels:** Barlow Semi Condensed (self-hosted in `public/fonts`, SIL OFL) for agent handles, the wordmark, monogram tiles and small uppercase bay labels (11px, +0.1em tracking). Its narrow, upright letters come from strip-board lettering.
- **Code and data:** the platform monospace, only for code, paths, commands, activity logs and numbers that line up (tabular numerals). Never as a "technical" costume.

## Layout

- Three columns: rail (264px) with logo, New session, Needs you, search and sessions; chat (max 800px measure) with header, member bar, thread and pinned composer; session panel (400px) on the right.
- Layout options (Appearance): sidebar left or right, panel right or bottom, comfortable or compact density, readable or full-width chat, font size, sidebar hidden. Stored per viewer.
- On Mac the window has no title bar; the traffic lights sit in the rail and empty header areas drag the window.
- The panel's Board tab is the signature: bays **Needs you**, **Working**, **Up next**, **Done** hold strips; a strip glides to its new bay when its state changes (FLIP). Empty bays collapse to one line.

## Elevation & Depth

Three levels, declared once each: flat (rail, page), raised (reply strips, board strips, cards: 1px line, no shadow), floating (popovers, menus, modals: `--shadow-pop`, an offset soft shadow, no border glow). Modals sit on a dimmed backdrop. No coloured halos, no glass.

## Shapes

Radii: 6px (tiles, small controls), 8px (buttons, inputs), 10px (cards, board strips), 14px (reply strips, modals), pill only for tiny status tags and the hand-off chip. Callsign tiles are squares with a two-letter monogram, never circles or avatars.

## Components

- **Reply strip:** header row (callsign tile, handle, account, time, duration, state tag) above the body; activity log, files changed, approvals, questions, then a ruled **Status** line at the foot. Waiting replies get an amber border, nothing else.
- **Hand-off chip:** one tile passing to the next (tile › tile), centred in the thread.
- **Question and approval cards:** amber-tinted inset cards with options as buttons and a free-text answer.
- **Board strip:** tile, handle, account, what it is doing, elapsed time; state tag on the right.
- **Composer:** pinned bottom, attachment and send as icon buttons, @-suggestions popover from the caret.
- **Settings:** a window with side navigation (Agents and accounts, Connectors, Skills, Appearance, About), not tabs.
- **Icons:** `public/icons.js`, about 45 icons on one 24px grid with 1.6px round strokes, drawn for this app; they inherit `currentColor`. No emoji or Unicode stand-ins.
- **Logo:** three arcs (sand, white, sky) around a centre point: a circle of agents with you in the middle. `build/icon.svg` is the app icon (rendered to `build/icon.png` by `scripts/make-logo.js`); `public/logo.svg` and `public/logo-mark.svg` are the lockup and mark.

## Motion

- Curves: strong ease-out `cubic-bezier(0.23, 1, 0.32, 1)` for entering and feedback, ease-in-out `cubic-bezier(0.77, 0, 0.175, 1)` for on-screen movement, the drawer curve `cubic-bezier(0.32, 0.72, 0, 1)` for the panel. Durations 120 / 180 / 240ms. Never ease-in.
- What moves: new messages rise 6px and fade in; modals and popovers scale from 0.98 with `@starting-style`; the panel slides 10px; board strips glide between bays; buttons and chips press to 0.97; tooltips wait once, then open instantly on neighbours.
- What doesn't: anything triggered from the keyboard (shortcuts, the @ menu), hover states beyond colour, decorative loops. The only loops are tied to live work: the progress line while an agent is working and the spinner.
- `prefers-reduced-motion`: movement is removed, fades and colour changes stay.

## Do's and Don'ts

- Do attribute everything to an agent: tile, handle, account on every reply, strip, file and commit.
- Do keep amber for "needs you" only, and cyan for action only.
- Do theme the browser parts: selection, caret, scrollbars, focus rings, tabular numerals.
- Don't add cards inside cards, eyebrow labels over headings, gradient text, glows, or coloured side borders on cards.
- Don't animate keyboard actions or add motion that isn't tied to a state change.
- Don't introduce a new accent colour; add a theme instead, defining every token.
