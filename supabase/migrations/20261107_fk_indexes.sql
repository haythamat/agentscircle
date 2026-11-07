-- Cover foreign keys flagged by the Supabase performance advisor.
create index if not exists audit_events_actor_idx on public.audit_events (actor_id);
create index if not exists orgs_owner_idx on public.orgs (owner_id);
