// Issues the signed plan token the desktop app caches. The caller must be signed in (verify_jwt).
// Private key: edge function secret PLAN_PRIVATE_KEY (ed25519, PEM). The app holds the public half.
import { createClient } from "jsr:@supabase/supabase-js@2";

const RANK: Record<string, number> = { free: 0, pro: 1, teams: 2 };
const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function signingKey() {
  const pem = (Deno.env.get("PLAN_PRIVATE_KEY") ?? "").replace(/-----[^-]+-----|\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, "Ed25519", false, ["sign"]);
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await asUser.auth.getUser();
    if (!u?.user) return json({ error: "not signed in" }, 401);
    const uid = u.user.id;

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: mem, error: memErr } = await admin.from("memberships").select("org_id").eq("user_id", uid);
    if (memErr) return json({ error: "lookup failed, try again" }, 503);
    const orgIds = (mem ?? []).map((m: { org_id: string }) => m.org_id);
    let q = admin.from("subscriptions").select("plan,status,founding,past_due_since,user_id,org_id");
    q = orgIds.length ? q.or(`user_id.eq.${uid},org_id.in.(${orgIds.join(",")})`) : q.eq("user_id", uid);
    const { data: subs, error } = await q;
    if (error) return json({ error: "lookup failed, try again" }, 503);

    // Only subscriptions that grant access right now compete; the best of those wins.
    const now = Date.now();
    const PAST_DUE_MS = 7 * 86400000;
    const live = (subs ?? []).filter((s: { status: string; past_due_since: string | null }) =>
      s.status === "active" || s.status === "trialing" ||
      (s.status === "past_due" && !!s.past_due_since && now - Date.parse(s.past_due_since) <= PAST_DUE_MS));
    live.sort((a: { plan: string }, b: { plan: string }) => RANK[b.plan] - RANK[a.plan]);
    const s = live[0] ?? { plan: "free", status: "active", founding: false, past_due_since: null };
    const payload = {
      plan: s.plan, status: s.status, founding: !!s.founding, sub: uid,
      pastDueSince: s.past_due_since ? Date.parse(s.past_due_since) : undefined,
      issuedAt: now,
      expiresAt: now + 14 * 86400000, // offline lifetime, signed so the app cannot extend it
    };
    const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign("Ed25519", await signingKey(), new TextEncoder().encode(body));
    return json({ token: `${body}.${b64u(sig)}` });
  } catch (_e) {
    return json({ error: "could not issue a token" }, 500);
  }
});
