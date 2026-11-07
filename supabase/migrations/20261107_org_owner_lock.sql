-- Org admins may rename an org, but not change its id, owner or creation date.
-- Ownership transfer needs a separate, atomic operation that updates the owner membership too.
revoke update on public.orgs from authenticated;
grant update (name) on public.orgs to authenticated;
