# Account sign-in review — 2026-11-07

Scope: current `src/account.js`, account routes in `src/server.js`, entitlement integration, vault storage and desktop account controls. Review only; no application code, production configuration, database, or keys changed.

**Status (2026-11-07, @claude):** findings 1–4 fixed in `src/account.js` and `src/entitlements.js`; the test file now has 12 tests, all passing. The results under Verification describe the code as first reviewed. Automatic plan refresh and the live GitHub round trip are still open.

## Findings

1. **P1 — Bind cached entitlements and every token ingestion path to the active account.** `src/account.js:17`, `src/account.js:56`, `src/server.js:1182`, `src/entitlements.js:48`. The subject check at account.js:71 protects only newly fetched tokens. A cached Pro token still grants paid access when the account session is unavailable at startup (including a restart outside Electron), and after a rejected refresh clears the session. The existing POST `/api/plan/token` route also calls `setToken` without a signed-in-account or subject check. A valid token for another account therefore bypasses the newly added binding through that route. Two local tests reproduce access while signed out; the route bypass is confirmed by inspecting its direct call, not by starting the server. Centralize subject enforcement for token installation and cached access; clear or disable mismatched plans and clear entitlements on definitive session invalidation. Preserve offline access for a cached session belonging to the same user.

2. **P2 — Prevent in-flight authentication from undoing sign-out.** `src/account.js:42`, `src/account.js:45`, `src/account.js:53`, `src/account.js:59`, `src/account.js:77`. Sign-out clears current state but does not invalidate outstanding network operations. Reproduction: pause the PKCE exchange, sign out, then release the response. The callback signs the user back in and installs their paid plan. The refresh path has the same unconditional session assignment after an await. Capture a session/attempt generation and check it before each session, vault or plan mutation; increment it on sign-out and when replacing a login. Add a deferred-refresh regression as well as the included deferred-callback test.

3. **P2 — Validate state before consuming the pending login.** `src/account.js:39`. A callback with missing or wrong state sets `pending = null` before validation, so the legitimate callback immediately afterward fails. This does not bypass authentication, but a stray callback or top-level navigation to the loopback callback can cancel sign-in. Reject unrelated callbacks without consuming the active attempt. Consume a matching attempt before code exchange to retain replay protection. The invalid-state-followed-by-valid-state test fails; successful callback replay is correctly rejected.

4. **P2 — Do not erase the session on a retryable refresh response.** `src/account.js:55`. Every 4xx response clears the session and deletes its vault entry, including HTTP 429. Reproduction: sign in, advance the test clock one hour, return 429 from token refresh; the app becomes signed out. Classify explicit invalid/revoked refresh-token errors separately, retain the session on rate limits and other retryable failures, and expose a retryable error. Clear the plan together with the session on definitive rejection, as described in finding 1.

## Verification

Run `node --test docs/reviews/account-signin-review.test.cjs` from the repository root.

Result on reviewed code: **7 tests, 2 passed, 5 failed**. Failures assert desired behavior and intentionally remain failing until the application is fixed. The two passes verify the PKCE challenge/verifier relationship with callback replay rejection, and rejection of a wrong-subject token for a fresh account. Fixtures use mocked HTTP, a newly generated temporary signing key, in-memory account sessions and disposable directories. They never read the production private key or real user data.

The live GitHub round trip, redirect allowlist, deployed function and Electron UI were not exercised. Production RLS testing is outside this account review. Supabase's [PKCE guide](https://supabase.com/docs/guides/auth/sessions/pkce-flow) and [advanced auth guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide) were consulted. The required changelog fetch failed (web content-type rejection; shell DNS unavailable), so no claim is made about a complete changelog check.

## Follow-up for Claude

Fix these four issues before treating account integration as complete. Run the included regressions, add coverage for sign-out during refresh and the direct token route, then test a real GitHub sign-in in Electron. No schema or key changes are required for these findings. Separately, automatic refresh is currently absent: `refreshPlan` runs only after login or from the manual button, so plan renewal currently requires user action.
