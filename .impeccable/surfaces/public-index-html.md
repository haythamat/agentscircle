---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/panel.js"]
---

# AgentsCircle app (all screens)

Scope: the desktop app UI in public/ (sessions sidebar, chat, session panel, settings, dialogs). Mode: Operate. Users: solo vibe coders and small teams, open all day and in check-ins. Must keep light and dark themes; add more themes and VS Code-style layout options. Must not feel playful, terminal-like, generic SaaS or flashy.

## Direction contract

THESIS: Every turn is a flight strip handed between agents; the app is the calm board where you see who holds which strip and which one waits for you. It refuses the grey-dashboard-with-one-accent default and the terminal look.

OWN-WORLD: Graphite board grounds (dark: green-tinted graphite; light: daylight grey), raised strip surfaces, agent identity as a square callsign tile with a two-letter monogram in a condensed grotesk (Barlow Semi Condensed), body in the platform UI face, signal cyan for primary action and focus, amber only for "needs you", green done, red error. Thin rules, 8/12px radii, no glow.

STORY: The user sees at once which agents are working, which turn waits for them, and who changed what; they @mention, approve, answer and commit without hunting.

FIRST VIEWPORT: Left rail with logo, Needs-you strip, session list with state; centre chat where each agent reply opens with a strip header (callsign tile, handle, account, time, status) above the body; composer pinned bottom with icon controls; right panel opens on the Board: bays Queued, Working, Needs you, Done holding strips.

FORM: air-traffic flight progress strips, candidate 6 of 7 on my ordered list; seed:915146ac192f119f. Signature interaction: strips move between board bays (FLIP motion) and a hand-off passes the strip to the next agent. Motion grammar: 150-220ms strong ease-out, enter from 6px and 0 opacity, press scale .97, no motion on keyboard actions, reduced-motion respected.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
