-- Notes and table chat.
--
--   * notes: each member's own notes for a chronicle. Only the author ever reads or writes
--     them, storytellers included; at most 200 per person per chronicle.
--   * messages: chat at a table, shown in the feed with the rolls. Everyone at the table
--     reads a message, unless it is whispered to one person: then only its sender and that
--     person do. Messages are written only by send_message, which checks who may speak and
--     to whom and keeps anyone from flooding the table. Their sender and the storytellers
--     can delete them.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  chronicle_id uuid not null references public.chronicles (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 120),
  body text not null default '' check (char_length(body) <= 20000),
  -- the list of notes reads this, so it never downloads every note in full (egress)
  preview text generated always as (left(body, 160)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notes_owner_idx on public.notes (user_id, chronicle_id, updated_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null,
  chronicle_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  -- the sender's name, and the character they played at this table, when they wrote it
  who text not null,
  character_name text,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  -- a whisper: one person at the table, who must belong to the chronicle
  to_user uuid references auth.users (id) on delete cascade,
  -- clock time, like rolls, so the feed keeps the order things happened in
  created_at timestamptz not null default clock_timestamp(),
  foreign key (table_id, chronicle_id) references public.game_tables (id, chronicle_id) on delete cascade,
  foreign key (chronicle_id, to_user) references public.chronicle_members (chronicle_id, user_id) on delete cascade
);
create index messages_table_idx on public.messages (table_id, created_at desc);
create index messages_sender_idx on public.messages (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.notes enable row level security;
alter table public.messages enable row level security;

create policy "you see your own notes" on public.notes
  for select to authenticated using (user_id = auth.uid() and public.is_member(chronicle_id));
create policy "you write your own notes" on public.notes
  for insert to authenticated with check (user_id = auth.uid() and public.is_member(chronicle_id));
create policy "you edit your own notes" on public.notes
  for update to authenticated using (user_id = auth.uid() and public.is_member(chronicle_id))
  with check (user_id = auth.uid() and public.is_member(chronicle_id));
create policy "you delete your own notes" on public.notes
  for delete to authenticated using (user_id = auth.uid());

create policy "the table reads its chat, a whisper only its sender and recipient" on public.messages
  for select to authenticated
  using (public.at_table(table_id) and (to_user is null or user_id = auth.uid() or to_user = auth.uid()));
create policy "senders and storytellers delete messages" on public.messages
  for delete to authenticated
  using (public.at_table(table_id) and (user_id = auth.uid() or public.is_storyteller(chronicle_id)));

-- Table privileges, as in the first migration: nothing for the anonymous role, reads for
-- signed-in users (row level security picks the rows), writes only where granted. A note's
-- owner comes from its column default, never from the browser; messages have no insert grant.
revoke all on public.notes, public.messages from anon, authenticated;
grant select on public.notes, public.messages to authenticated;
grant insert (chronicle_id, title, body) on public.notes to authenticated;
grant update (title, body) on public.notes to authenticated;
grant delete on public.notes, public.messages to authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger notes_touch before update on public.notes
  for each row execute function public.touch_updated_at();

create function public.notes_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.notes n where n.user_id = new.user_id and n.chronicle_id = new.chronicle_id) >= 200 then
    raise exception 'You have 200 notes in this chronicle already. Delete some to make room.';
  end if;
  return new;
end $$;
create trigger notes_limit before insert on public.notes
  for each row execute function public.notes_limit();

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

create function public.send_message(p_table uuid, p_body text, p_to uuid default null)
returns public.messages
language plpgsql security definer set search_path = '' as $$
declare
  t public.game_tables;
  b text := btrim(coalesce(p_body, ''));
  speaker text;
  played text;
  m public.messages;
begin
  select * into t from public.game_tables g where g.id = p_table;
  if t.id is null or not public.at_table(p_table) then
    raise exception 'You are not at this table.' using errcode = '42501';
  end if;
  if b = '' then raise exception 'Write something first.'; end if;
  if char_length(b) > 1000 then raise exception 'That message is too long: keep it under 1000 characters.'; end if;
  if p_to is not null then
    if p_to = auth.uid() then raise exception 'You can''t whisper to yourself.'; end if;
    if not (exists (select 1 from public.seats s where s.table_id = p_table and s.user_id = p_to)
            or exists (select 1 from public.chronicle_members cm
                       where cm.chronicle_id = t.chronicle_id and cm.user_id = p_to and cm.role = 'storyteller')) then
      raise exception 'That person isn''t at this table.';
    end if;
  end if;
  if (select count(*) from public.messages x
      where x.user_id = auth.uid() and x.created_at > clock_timestamp() - interval '10 seconds') >= 10 then
    raise exception 'Slow down a little: that''s a lot of messages at once.';
  end if;

  select p.display_name into speaker from public.profiles p where p.id = auth.uid();
  select c.name into played
    from public.seats s join public.characters c on c.id = s.character_id
   where s.table_id = p_table and s.user_id = auth.uid();
  insert into public.messages (table_id, chronicle_id, user_id, who, character_name, body, to_user)
  values (p_table, t.chronicle_id, auth.uid(), coalesce(speaker, 'Someone'), played, b, p_to)
  returning * into m;
  return m;
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges: new functions are callable by everyone until told otherwise
-- ---------------------------------------------------------------------------

revoke execute on function public.send_message(uuid, text, uuid) from public, anon;
grant execute on function public.send_message(uuid, text, uuid) to authenticated;
revoke execute on function public.notes_limit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: the table hears new and deleted messages (each event filtered by the policies)
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.messages;
