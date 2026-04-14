-- Run in Supabase: Dashboard → SQL → New query → Run.
-- RLS on with no policies: only the service role (used by this app’s server) can read/write.

create table if not exists public.reaction_stats (
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null,
  count integer not null default 0 check (count >= 0),
  primary key (user_id, emoji)
);

create index if not exists reaction_stats_user_id_idx on public.reaction_stats (user_id);

alter table public.reaction_stats enable row level security;
