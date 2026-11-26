-- Связь грязь / MVP schema for Supabase
-- Run once in Supabase SQL Editor. Then create Storage buckets:
--   chat-files (private), avatars (public).

create extension if not exists pgcrypto;

create or replace function public.make_friend_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  code text;
  letters constant text := 'abcdefghijklmnopqrstuvwxyz';
begin
  loop
    code := lpad(floor(random() * 10000)::int::text, 4, '0')
      || substr(letters, floor(random() * 26)::int + 1, 1)
      || substr(letters, floor(random() * 26)::int + 1, 1);
    exit when not exists (select 1 from public.profiles p where p.friend_code = code);
  end loop;
  return code;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.-]{3,24}$'),
  nickname text not null check (char_length(nickname) between 2 and 32),
  friend_code text not null unique default public.make_friend_code() check (friend_code ~ '^[0-9]{4}[a-z]{2}$'),
  avatar_url text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  picked_username text;
  picked_nickname text;
begin
  picked_username := lower(coalesce(nullif(new.raw_user_meta_data->>'username', ''), 'user_' || substr(new.id::text, 1, 8)));
  picked_nickname := coalesce(nullif(trim(new.raw_user_meta_data->>'nickname'), ''), picked_username);
  insert into public.profiles(id, username, nickname)
  values(new.id, picked_username, picked_nickname);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.guard_profile_identity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.id <> old.id or new.username <> old.username or new.friend_code <> old.friend_code then
    raise exception 'Profile id, username and friend code are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists profile_identity_is_immutable on public.profiles;
create trigger profile_identity_is_immutable
before update on public.profiles
for each row execute procedure public.guard_profile_identity();

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  constraint friend_request_not_self check (sender_id <> receiver_id),
  constraint friend_request_unique_pair unique (sender_id, receiver_id)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 2048),
  subscription jsonb not null check (jsonb_typeof(subscription) = 'object'),
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions(user_id);

-- A browser endpoint belongs to one account at a time. This SECURITY DEFINER RPC
-- safely transfers it when the user signs into a different account on the device.
create or replace function public.save_push_subscription(
  p_endpoint text,
  p_subscription jsonb,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  saved_id uuid;
begin
  if me is null then
    raise exception 'Authentication required';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2048 then
    raise exception 'Invalid push endpoint';
  end if;
  if jsonb_typeof(p_subscription) is distinct from 'object'
    or p_subscription->>'endpoint' is distinct from p_endpoint
    or jsonb_typeof(p_subscription->'keys') is distinct from 'object'
    or coalesce(p_subscription #>> '{keys,p256dh}', '') = ''
    or coalesce(p_subscription #>> '{keys,auth}', '') = ''
    or octet_length(p_subscription::text) > 8192 then
    raise exception 'Invalid push subscription';
  end if;

  insert into public.push_subscriptions(user_id, endpoint, subscription, user_agent, updated_at)
  values(me, p_endpoint, p_subscription, left(p_user_agent, 512), now())
  on conflict (endpoint) do update set
    user_id = excluded.user_id,
    subscription = excluded.subscription,
    user_agent = excluded.user_agent,
    updated_at = now()
  returning id into saved_id;
  return saved_id;
end;
$$;

create or replace function public.guard_friend_request_update()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.id <> old.id or new.sender_id <> old.sender_id or new.receiver_id <> old.receiver_id or new.created_at <> old.created_at then
    raise exception 'Friend request identity is immutable';
  end if;
  if old.status <> 'pending' or new.status not in ('accepted', 'declined') or auth.uid() <> old.receiver_id then
    raise exception 'Only the receiver may accept or decline a pending request';
  end if;
  return new;
end;
$$;

drop trigger if exists friend_request_update_guard on public.friend_requests;
create trigger friend_request_update_guard
before update on public.friend_requests
for each row execute procedure public.guard_friend_request_update();

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  direct_key text unique,
  is_group boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 4000),
  message_type text not null default 'text' check (message_type in ('text', 'image', 'file', 'audio')),
  attachment_path text,
  attachment_name text,
  attachment_mime text,
  attachment_size bigint,
  created_at timestamptz not null default now(),
  constraint message_has_content check (body <> '' or attachment_path is not null)
);

create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index if not exists friend_requests_receiver_status_idx on public.friend_requests(receiver_id, status);

create or replace function public.get_or_create_direct_conversation(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  pair_key text;
  conversation_id uuid;
begin
  if me is null then
    raise exception 'Authentication required';
  end if;
  if other_user_id is null or other_user_id = me then
    raise exception 'Invalid friend';
  end if;
  if not exists (
    select 1 from public.friend_requests fr
    where fr.status = 'accepted'
      and ((fr.sender_id = me and fr.receiver_id = other_user_id)
        or (fr.sender_id = other_user_id and fr.receiver_id = me))
  ) then
    raise exception 'You must be friends to open a chat';
  end if;

  pair_key := least(me::text, other_user_id::text) || ':' || greatest(me::text, other_user_id::text);
  insert into public.conversations(created_by, direct_key, is_group)
  values(me, pair_key, false)
  on conflict (direct_key) do nothing;

  select c.id into conversation_id from public.conversations c where c.direct_key = pair_key;
  insert into public.conversation_members(conversation_id, user_id)
  values(conversation_id, me), (conversation_id, other_user_id)
  on conflict do nothing;
  return conversation_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.push_subscriptions enable row level security;

-- Signed-in users may find a profile by its public friend code.
drop policy if exists "profiles readable by signed-in users" on public.profiles;
create policy "profiles readable by signed-in users" on public.profiles
for select to authenticated using (auth.uid() is not null);
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles
for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "users manage own push subscriptions" on public.push_subscriptions;
drop policy if exists "users delete own push subscriptions" on public.push_subscriptions;
create policy "users delete own push subscriptions" on public.push_subscriptions
for delete to authenticated using (user_id = auth.uid());

drop policy if exists "participants read friend requests" on public.friend_requests;
create policy "participants read friend requests" on public.friend_requests
for select to authenticated using (sender_id = auth.uid() or receiver_id = auth.uid());
drop policy if exists "users send friend requests" on public.friend_requests;
create policy "users send friend requests" on public.friend_requests
for insert to authenticated with check (sender_id = auth.uid() and receiver_id <> auth.uid() and status = 'pending');
drop policy if exists "receiver updates request" on public.friend_requests;
create policy "receiver updates request" on public.friend_requests
for update to authenticated using (receiver_id = auth.uid()) with check (receiver_id = auth.uid());

drop policy if exists "members read conversations" on public.conversations;
create policy "members read conversations" on public.conversations
for select to authenticated using (exists (
  select 1 from public.conversation_members cm
  where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
));
-- Membership creation is only through the security-definer RPC above.
drop policy if exists "users read own membership" on public.conversation_members;
create policy "users read own membership" on public.conversation_members
for select to authenticated using (user_id = auth.uid());

drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
for select to authenticated using (exists (
  select 1 from public.conversation_members cm
  where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
));
drop policy if exists "members send messages as self" on public.messages;
create policy "members send messages as self" on public.messages
for insert to authenticated with check (
  sender_id = auth.uid() and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
  )
);

-- Storage: create a private 'chat-files' bucket and a public 'avatars' bucket in Dashboard.
-- File paths are: <uploader-uuid>/<conversation-uuid>/<filename>.
drop policy if exists "chat members can read files" on storage.objects;
create policy "chat members can read files" on storage.objects
for select to authenticated using (
  bucket_id = 'chat-files'
  and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id::text = (storage.foldername(name))[2]
      and cm.user_id = auth.uid()
  )
);
drop policy if exists "users upload their chat files" on storage.objects;
create policy "users upload their chat files" on storage.objects
for insert to authenticated with check (
  bucket_id = 'chat-files'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id::text = (storage.foldername(name))[2]
      and cm.user_id = auth.uid()
  )
);
drop policy if exists "users update their chat files" on storage.objects;
create policy "users update their chat files" on storage.objects
for update to authenticated using (
  bucket_id = 'chat-files'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id::text = (storage.foldername(name))[2]
      and cm.user_id = auth.uid()
  )
) with check (
  bucket_id = 'chat-files'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id::text = (storage.foldername(name))[2]
      and cm.user_id = auth.uid()
  )
);
drop policy if exists "users delete their chat files" on storage.objects;
create policy "users delete their chat files" on storage.objects
for delete to authenticated using (
  bucket_id = 'chat-files' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "avatars are public" on storage.objects;
create policy "avatars are public" on storage.objects
for select to public using (bucket_id = 'avatars');
drop policy if exists "users upload own avatar" on storage.objects;
create policy "users upload own avatar" on storage.objects
for insert to authenticated with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users update own avatar" on storage.objects;
create policy "users update own avatar" on storage.objects
for update to authenticated using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "users delete own avatar" on storage.objects;
create policy "users delete own avatar" on storage.objects
for delete to authenticated using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Enable Realtime for new chat messages.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then
  null;
end;
$$;

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.friend_requests to authenticated;
grant select on public.conversations to authenticated;
grant select on public.conversation_members to authenticated;
grant select, insert on public.messages to authenticated;
grant execute on function public.get_or_create_direct_conversation(uuid) to authenticated;

revoke all on public.push_subscriptions from anon, authenticated;
grant delete on public.push_subscriptions to authenticated;
grant select, delete on public.push_subscriptions to service_role;
revoke all on function public.save_push_subscription(text, jsonb, text) from public, anon;
grant execute on function public.save_push_subscription(text, jsonb, text) to authenticated;
grant usage on schema public to service_role;
grant select on public.profiles, public.conversation_members, public.messages to service_role;
