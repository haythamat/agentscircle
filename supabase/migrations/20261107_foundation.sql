-- AgentsCircle Phase 1 foundation: profiles, orgs, memberships, subscriptions,
-- synced sessions, audit events. RLS on every table. Billing writes are service-role only.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  owner_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships(user_id);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  org_id uuid references public.orgs(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','pro','teams')),
  status text not null default 'active' check (status in ('active','past_due','canceled')),
  gateway text check (gateway in ('stripe','paytabs')),
  gateway_customer_id text,
  seats int check (seats is null or seats >= 1),
  founding boolean not null default false,
  current_period_end timestamptz,
  past_due_since timestamptz,
  updated_at timestamptz not null default now(),
  check ((user_id is not null) <> (org_id is not null))
);
create unique index subscriptions_user_uq on public.subscriptions(user_id) where user_id is not null;
create unique index subscriptions_org_uq on public.subscriptions(org_id) where org_id is not null;

create table public.synced_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid references public.orgs(id) on delete set null,
  title text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index synced_sessions_owner_idx on public.synced_sessions(owner_id);
create index synced_sessions_org_idx on public.synced_sessions(org_id);

create table public.audit_events (
  id bigint generated always as identity primary key,
  org_id uuid references public.orgs(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_org_idx on public.audit_events(org_id, created_at desc);

-- Helpers (security definer avoids RLS recursion on memberships)
create function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.org_id = p_org and m.user_id = (select auth.uid()));
$$;
create function public.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.org_id = p_org and m.user_id = (select auth.uid())
                   and m.role in ('owner','admin'));
$$;
revoke execute on function public.is_org_member(uuid), public.is_org_admin(uuid) from public, anon;
grant execute on function public.is_org_member(uuid), public.is_org_admin(uuid) to authenticated;

-- New user: profile + free subscription
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  insert into public.subscriptions (user_id, plan) values (new.id, 'free');
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- New org: owner becomes a member and the org gets a free subscription
create function public.handle_new_org() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.memberships (org_id, user_id, role) values (new.id, new.owner_id, 'owner');
  insert into public.subscriptions (org_id, plan) values (new.id, 'free');
  return new;
end;
$$;
revoke execute on function public.handle_new_org() from public, anon, authenticated;
create trigger on_org_created after insert on public.orgs
  for each row execute function public.handle_new_org();

-- RLS
alter table public.profiles enable row level security;
alter table public.orgs enable row level security;
alter table public.memberships enable row level security;
alter table public.subscriptions enable row level security;
alter table public.synced_sessions enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy orgs_select on public.orgs for select to authenticated
  using (public.is_org_member(id));
create policy orgs_insert on public.orgs for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy orgs_update on public.orgs for update to authenticated
  using (public.is_org_admin(id)) with check (public.is_org_admin(id));

create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.is_org_member(org_id));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (public.is_org_admin(org_id) and role <> 'owner');
create policy memberships_update on public.memberships for update to authenticated
  using (public.is_org_admin(org_id) and role <> 'owner')
  with check (public.is_org_admin(org_id) and role <> 'owner');
create policy memberships_delete on public.memberships for delete to authenticated
  using (role <> 'owner' and (public.is_org_admin(org_id) or user_id = (select auth.uid())));

-- subscriptions: read-only for clients; only the service role (webhooks) writes
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()) or (org_id is not null and public.is_org_member(org_id)));

create policy sessions_select on public.synced_sessions for select to authenticated
  using (owner_id = (select auth.uid()) or (org_id is not null and public.is_org_member(org_id)));
create policy sessions_insert on public.synced_sessions for insert to authenticated
  with check (owner_id = (select auth.uid()) and (org_id is null or public.is_org_member(org_id)));
create policy sessions_update on public.synced_sessions for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and (org_id is null or public.is_org_member(org_id)));
create policy sessions_delete on public.synced_sessions for delete to authenticated
  using (owner_id = (select auth.uid()));

-- audit: org admins read; members append their own events; nobody edits or deletes
create policy audit_select on public.audit_events for select to authenticated
  using (org_id is not null and public.is_org_admin(org_id));
create policy audit_insert on public.audit_events for insert to authenticated
  with check (actor_id = (select auth.uid()) and org_id is not null and public.is_org_member(org_id));
