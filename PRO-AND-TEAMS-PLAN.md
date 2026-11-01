# AgentsCircle: plan to prepare Pro and Teams

Sources: the public roadmap page (agentscircle.dev/roadmap, read today), the session roadmap file (28 Oct 2026), and `SKI-feature-ideas.md`. Prices and vote counts below are hypotheses or unlabeled page data, not validated numbers.

## 1. What the public roadmap says today

| Section | Items |
| --- | --- |
| Free, coming soon | Edit .pptx/.docx in the Files tab; Gemini CLI, Aider, Goose; Windows ARM and Linux .deb/.rpm; themes and shortcut editor |
| Pro | Approve from your phone; sync sessions between computers; agents keep running in the cloud; scheduled tasks; search across all past sessions |
| Teams | Shared sessions; shared connector and skill library; admin rules; team usage and cost dashboard; audit log; SSO |

The page promises "The free app stays free", has a Pro waitlist, a suggestion form, and per-item votes (1 vote on "approve from phone" and "sync", 0 on everything else). It has no prices and shows no ideas yet, because suggestions only appear once approved.

## 2. Problems to fix before selling anything

1. **The page and the internal roadmap disagree.**
   - Internal v1.x table: Free is limited to 2 accounts and 30 days of history; Pro gets unlimited accounts and history.
   - Public page: "The free app stays free." Gating things users already have breaks that promise.
   - **Recommendation:** do not take away anything that already ships free. Multiple accounts, session history and search across sessions already exist (v0.2, v0.4). Keep them free. Pro should sell *new* things: cloud, mobile, scheduling, sync.
2. **"Search across all past sessions" is listed as Pro, but local search shipped in v0.4.** Resolve it: keep local search free; Pro gets *synced* search across computers and cloud-stored sessions.
3. **The roadmap file is stale.** Items marked open (landing page, docs, demo video, usage stats) have shipped (1.3.13 added opt-in counts). Update it so decisions are made on facts.
4. **Votes are tiny.** Two total votes is not demand data. Use the waitlist plus a short survey before committing to build order.

## 3. Principle: sell what needs a server or saves time

Everything local stays free (it costs nothing to run and spreads the product). Paid tiers cover things that need our infrastructure or coordination between people:

- **Pro = your work follows you:** cloud, mobile, schedules, sync.
- **Teams = control and sharing:** shared sessions, admin, audit, SSO.

## 4. Tier definition (proposed)

| Capability | Free | Pro | Teams |
| --- | --- | --- | --- |
| Group chat, @mentions, all agents, accounts, worktrees, approvals, checkpoints, local search | Yes | Yes | Yes |
| More agents (Gemini, Aider, Goose), themes, shortcuts, Office editing | Yes | Yes | Yes |
| Approve / answer "Needs you" from phone | No | Yes | Yes |
| Sync sessions across computers | No | Yes | Yes |
| Scheduled and recurring tasks | No | Yes | Yes |
| Agents keep running when laptop sleeps | No | Yes | Yes |
| Saved chains / session templates | Basic (3) | Unlimited | Unlimited, shareable |
| Usage and cost dashboard | Local, per session (today's Used tab) | Cross-computer history | Team-wide |
| Shared live sessions | No | No | Yes |
| Shared connector and skill library | No | No | Yes |
| Admin rules, roles, audit log, SSO | No | No | Yes |

Price hypotheses to test with the waitlist: Pro about $10 to 15 per month, Teams about $20 to 30 per seat per month (3-seat minimum). These are guesses; validate before publishing.

## 5. Foundation work (needed before any paid feature)

Build these once; every Pro and Teams feature depends on them.

1. **Accounts and sign-in** (optional, never required for the free app). Supabase Auth (email, GitHub, Google). The app stays fully usable signed out.
2. **Entitlements.** One function in the app, `can(feature)`, backed by a signed license/plan token cached locally with an offline grace period (about 14 days). All gates go through it, so changing a tier is a one-line change.
3. **Billing.** Stripe Checkout and customer portal; webhook updates the plan in the database. Teams adds seats and invoices.
4. **Backend.** Supabase: users, orgs, memberships, plans, synced sessions, audit events. Row-level security from day one. Store chat history only; code and agent logins stay on each computer (as the roadmap already states).
5. **Encryption and privacy.** Encrypt synced sessions client-side where practical; update the privacy doc; decide data region and retention; add export and delete-my-data. Keep the opt-in usage counts separate from account data.
6. **Licence and legal.** The repo uses FSL-1.1-ALv2 (competing-use restriction). Confirm paid code lives in a private repo or private module, finish the lawyer review of contributor terms, check each agent provider's terms on automation and shared accounts (already flagged as a risk), and write terms of service and a refund policy.
7. **Observability.** Error reporting for the backend, uptime check, and a status page before cloud agents ship.

## 6. Phased plan

### Phase 0: now to +2 weeks, validate and clean up
**Status (1 Nov 2026):** public page edited in Lovable (in preview, not yet published to agentscircle.dev). Done: free-forever pledge on /roadmap, three shipped Free items added, Pro "search" item retitled to the cross-computer version (votes kept), optional pricing survey on the waitlist form. Still open: publish the site, the internal roadmap file (Orbita doc) still needs its unticked items ticked, and the decisions below.

- Update the roadmap file and public page to match reality; mark shipped items.
- Resolve the free-versus-Pro conflicts in section 2 and publish a one-paragraph "what stays free forever" pledge.
- Waitlist survey: which Pro feature, price range, solo or team, which agents. Aim for 30+ replies.
- Decide open questions: pricing, closed Pro module, who owns billing.

### Phase 1: +2 to 6 weeks, free wins and groundwork
- Ship free items that grow the audience: Gemini CLI (consider ACP so more agents come cheaply, per the SKI notes), themes and shortcut editor, Linux .deb/.rpm, Windows ARM.
- Setup status screen (installed, signed in, update available, fix command). Cuts first-run failures, which hurts conversion later.
- Build the foundation (section 5, items 1 to 4) behind a flag; no UI promises yet.
- Windows code signing (still open on the roadmap); paying customers will not accept SmartScreen warnings.

### Phase 2: +6 to 12 weeks, Pro launch
1. **Scheduled and recurring tasks** (first: smallest, runs locally, no server needed; cloud execution comes later). Based on the SKI `loop` idea.
2. **Saved chains / session templates** on top of existing @mention handoffs.
3. **Session sync** between computers (history, summaries, settings; not code).
4. **Approve from phone:** push notification plus a small web page to answer approvals and questions. Reuses the existing Needs-you inbox.
5. Launch: Stripe live, 14-day trial, waitlist emailed first, changelog and pricing page.

### Phase 3: +3 to 5 months, cloud agents and Teams beta
- **Agents running in the cloud** is the riskiest and most costly item (sandboxed machines, secrets, abuse, cost per turn). Start as a limited beta with spending caps; do not promise it until a prototype survives real use.
- Teams beta with 3 to 5 friendly teams: orgs and invites, **shared connector and skill library**, **team usage and cost dashboard** (reuses the Used tab data), **audit log**.
- **Shared live sessions** (hard: concurrent turns, who may approve, conflicting worktrees). Start with read-only join plus one controller, then widen.

### Phase 4: +5 to 8 months, Teams general availability
- Admin rules for agents, connectors and permissions (build on the existing permission levels and risky-action rules).
- SSO (SAML/OIDC); build only when a paying team asks, because it is costly to support.
- Open PR from worktree and a team approvals inbox as team-flow polish.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Free users feel something was taken away | Pledge in section 6, Phase 0; gate only new capabilities |
| Cloud agents are costly and hard to secure | Beta with caps; ship Pro without it first |
| Provider terms restrict shared or automated use | Legal check in Phase 0; users bring their own logins |
| Agent CLIs change and break adapters while we build paid features | Keep quick-fix release path; do not let the paid roadmap starve maintenance |
| Synced chats contain secrets | Client-side encryption, redaction option, clear privacy copy |
| Little demand signal | Survey and waitlist first; build in the order demand shows |

## 8. Decisions needed from you

1. Is "free stays free" a hard rule? (Recommended: yes, as above.)
2. Pro first-wave order: scheduled tasks, sync, phone approvals (recommended), or cloud agents first?
3. Target buyer to design for first: solo power users (Pro) or small teams?
4. Closed-source Pro module or the same repo under the current licence?
5. Price test ranges in section 4: ok to ask them in the waitlist survey?
