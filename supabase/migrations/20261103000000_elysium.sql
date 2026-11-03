-- Elysium: chronicles, tables, characters, revealed NPCs and handouts, V5 rolls, shared music.
--
-- Security model, in one place:
--   * Every table has row level security. A player reads only the chronicles they belong to,
--     the tables they are seated at, their own characters, and the NPCs and handouts a
--     storyteller revealed to them (directly or to a table they sit at).
--   * Storytellers read and manage everything in their chronicle.
--   * Dice are rolled here, never in the browser: rolls has no insert/update/delete grant,
--     only the security-definer roll functions below write it.
--   * NPC secrets live in their own table (npc_secrets) that only storytellers can read,
--     so a revealed NPC never exposes the storyteller's notes.
--   * Denormalized chronicle_id columns are pinned by composite foreign keys, so a row can
--     never point at another chronicle's table, NPC, handout or member.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.chronicles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 4000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create type public.member_role as enum ('storyteller', 'player');

create table public.chronicle_members (
  chronicle_id uuid not null references public.chronicles (id) on delete cascade,
  -- references profiles (one per auth user, made by a trigger) so the API can embed names
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.member_role not null default 'player',
  joined_at timestamptz not null default now(),
  primary key (chronicle_id, user_id)
);
create index chronicle_members_user_idx on public.chronicle_members (user_id);

create table public.game_tables (
  id uuid primary key default gen_random_uuid(),
  chronicle_id uuid not null references public.chronicles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (id, chronicle_id)
);
create index game_tables_chronicle_idx on public.game_tables (chronicle_id);

create table public.table_invites (
  table_id uuid primary key,
  chronicle_id uuid not null,
  code text not null unique,
  created_at timestamptz not null default now(),
  foreign key (table_id, chronicle_id) references public.game_tables (id, chronicle_id) on delete cascade
);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  chronicle_id uuid not null references public.chronicles (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  system text not null default 'vtm5' check (system = 'vtm5'),
  data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 262144),
  portrait_path text,
  source text not null default 'manual' check (source in ('manual', 'mundusmaker', 'progeny')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chronicle_id),
  -- a portrait can only live in this character's own media folder
  check (portrait_path is null
         or portrait_path like chronicle_id::text || '/characters/' || id::text || '/%')
);
create index characters_chronicle_idx on public.characters (chronicle_id);
create index characters_owner_idx on public.characters (owner_id);

create table public.seats (
  table_id uuid not null,
  user_id uuid not null,
  chronicle_id uuid not null,
  character_id uuid,
  joined_at timestamptz not null default now(),
  primary key (table_id, user_id),
  foreign key (table_id, chronicle_id) references public.game_tables (id, chronicle_id) on delete cascade,
  foreign key (chronicle_id, user_id) references public.chronicle_members (chronicle_id, user_id) on delete cascade,
  foreign key (character_id, chronicle_id) references public.characters (id, chronicle_id)
    on delete set null (character_id)
);
create index seats_user_idx on public.seats (user_id);

create table public.npcs (
  id uuid primary key default gen_random_uuid(),
  chronicle_id uuid not null references public.chronicles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  title text not null default '' check (char_length(title) <= 120),
  clan text not null default '' check (char_length(clan) <= 60),
  description text not null default '' check (char_length(description) <= 8000),
  portrait_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chronicle_id),
  check (portrait_path is null
         or portrait_path like chronicle_id::text || '/npcs/' || id::text || '/%')
);
create index npcs_chronicle_idx on public.npcs (chronicle_id);

-- What only storytellers know about an NPC. Created automatically with the NPC.
create table public.npc_secrets (
  npc_id uuid primary key,
  chronicle_id uuid not null,
  notes text not null default '' check (char_length(notes) <= 20000),
  hunger int not null default 1 check (hunger between 0 and 5),
  pools jsonb not null default '[]'::jsonb
    check (jsonb_typeof(pools) = 'array' and pg_column_size(pools) < 32768),
  foreign key (npc_id, chronicle_id) references public.npcs (id, chronicle_id) on delete cascade
);

create table public.handouts (
  id uuid primary key default gen_random_uuid(),
  chronicle_id uuid not null references public.chronicles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  kind text not null check (kind in ('text', 'image', 'pdf')),
  body text not null default '' check (char_length(body) <= 20000),
  file_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chronicle_id),
  check (file_path is null
         or file_path like chronicle_id::text || '/handouts/' || id::text || '/%')
);
create index handouts_chronicle_idx on public.handouts (chronicle_id);

-- A reveal shows one NPC or handout to one table (everyone seated there) or to one player.
create table public.reveals (
  id uuid primary key default gen_random_uuid(),
  chronicle_id uuid not null references public.chronicles (id) on delete cascade,
  npc_id uuid,
  handout_id uuid,
  table_id uuid,
  user_id uuid,
  revealed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(npc_id, handout_id) = 1),
  check (num_nonnulls(table_id, user_id) = 1),
  foreign key (npc_id, chronicle_id) references public.npcs (id, chronicle_id) on delete cascade,
  foreign key (handout_id, chronicle_id) references public.handouts (id, chronicle_id) on delete cascade,
  foreign key (table_id, chronicle_id) references public.game_tables (id, chronicle_id) on delete cascade,
  foreign key (chronicle_id, user_id) references public.chronicle_members (chronicle_id, user_id) on delete cascade
);
create unique index reveals_once on public.reveals (coalesce(npc_id, handout_id), coalesce(table_id, user_id));
create index reveals_npc_idx on public.reveals (npc_id);
create index reveals_handout_idx on public.reveals (handout_id);
create index reveals_chronicle_idx on public.reveals (chronicle_id);

create table public.rolls (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null,
  chronicle_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  character_id uuid references public.characters (id) on delete set null,
  npc_id uuid references public.npcs (id) on delete set null,
  who text not null,
  kind text not null check (kind in ('pool', 'rouse', 'remorse', 'reroll', 'tracker')),
  label text not null,
  parts jsonb not null default '[]'::jsonb,
  pool int not null,
  hunger int not null default 0,
  difficulty int,
  regular int[] not null default '{}',
  hunger_dice int[] not null default '{}',
  successes int not null,
  outcome text not null,
  flags text[] not null default '{}',
  effect text,
  private boolean not null default false,
  parent_id uuid references public.rolls (id) on delete set null,
  rerolled boolean not null default false,
  -- clock time, not transaction time: a Blood Surge writes its rouse check and its roll in one
  -- transaction, and the feed must show them in that order
  created_at timestamptz not null default clock_timestamp(),
  foreign key (table_id, chronicle_id) references public.game_tables (id, chronicle_id) on delete cascade
);
create index rolls_table_idx on public.rolls (table_id, created_at desc);

-- Music and the "show everyone" handout for one table. One row per table.
create table public.table_state (
  table_id uuid primary key,
  chronicle_id uuid not null,
  music jsonb,
  spotlight jsonb,
  updated_at timestamptz not null default now(),
  foreign key (table_id, chronicle_id) references public.game_tables (id, chronicle_id) on delete cascade
);

-- The storyteller's YouTube playlist for a chronicle.
create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  chronicle_id uuid not null references public.chronicles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  mood text not null default '' check (char_length(mood) <= 40),
  created_at timestamptz not null default now()
);
create index tracks_chronicle_idx on public.tracks (chronicle_id);

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer so policies can call them without recursion)
-- ---------------------------------------------------------------------------

create function public.is_member(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chronicle_members m
                 where m.chronicle_id = c and m.user_id = auth.uid());
$$;

create function public.is_storyteller(c uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chronicle_members m
                 where m.chronicle_id = c and m.user_id = auth.uid() and m.role = 'storyteller');
$$;

create function public.is_seated(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.seats s where s.table_id = t and s.user_id = auth.uid());
$$;

-- Seated at the table, or a storyteller of its chronicle.
create function public.at_table(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_seated(t)
      or exists (select 1 from public.game_tables g
                 where g.id = t and public.is_storyteller(g.chronicle_id));
$$;

create function public.shares_chronicle(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chronicle_members a
                 join public.chronicle_members b on b.chronicle_id = a.chronicle_id
                 where a.user_id = auth.uid() and b.user_id = other);
$$;

create function public.npc_revealed_to_me(n uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reveals r
                 where r.npc_id = n
                   and (r.user_id = auth.uid() or (r.table_id is not null and public.is_seated(r.table_id))));
$$;

create function public.handout_revealed_to_me(h uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reveals r
                 where r.handout_id = h
                   and (r.user_id = auth.uid() or (r.table_id is not null and public.is_seated(r.table_id))));
$$;

create function public.owns_character(ch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.characters c
                 where c.id = ch and c.owner_id = auth.uid() and public.is_member(c.chronicle_id));
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.chronicles enable row level security;
alter table public.chronicle_members enable row level security;
alter table public.game_tables enable row level security;
alter table public.table_invites enable row level security;
alter table public.characters enable row level security;
alter table public.seats enable row level security;
alter table public.npcs enable row level security;
alter table public.npc_secrets enable row level security;
alter table public.handouts enable row level security;
alter table public.reveals enable row level security;
alter table public.rolls enable row level security;
alter table public.table_state enable row level security;
alter table public.tracks enable row level security;

create policy "see yourself and the people you play with" on public.profiles
  for select to authenticated using (id = auth.uid() or public.shares_chronicle(id));
create policy "rename yourself" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "members see their chronicle" on public.chronicles
  for select to authenticated using (public.is_member(id));
create policy "storytellers edit their chronicle" on public.chronicles
  for update to authenticated using (public.is_storyteller(id)) with check (public.is_storyteller(id));
create policy "storytellers delete their chronicle" on public.chronicles
  for delete to authenticated using (public.is_storyteller(id));

create policy "members see the member list" on public.chronicle_members
  for select to authenticated using (public.is_member(chronicle_id));

create policy "seated players and storytellers see a table" on public.game_tables
  for select to authenticated using (public.at_table(id));
create policy "storytellers rename tables" on public.game_tables
  for update to authenticated using (public.is_storyteller(chronicle_id))
  with check (public.is_storyteller(chronicle_id));
create policy "storytellers delete tables" on public.game_tables
  for delete to authenticated using (public.is_storyteller(chronicle_id));

create policy "storytellers see invite codes" on public.table_invites
  for select to authenticated using (public.is_storyteller(chronicle_id));

create policy "owners and storytellers see characters" on public.characters
  for select to authenticated
  using ((owner_id = auth.uid() and public.is_member(chronicle_id)) or public.is_storyteller(chronicle_id));
create policy "owners and storytellers rename characters" on public.characters
  for update to authenticated
  using ((owner_id = auth.uid() and public.is_member(chronicle_id)) or public.is_storyteller(chronicle_id))
  with check ((owner_id = auth.uid() and public.is_member(chronicle_id)) or public.is_storyteller(chronicle_id));
create policy "owners and storytellers delete characters" on public.characters
  for delete to authenticated
  using ((owner_id = auth.uid() and public.is_member(chronicle_id)) or public.is_storyteller(chronicle_id));

create policy "everyone at a table sees its seats" on public.seats
  for select to authenticated using (public.at_table(table_id));

create policy "storytellers and revealed players see NPCs" on public.npcs
  for select to authenticated using (public.is_storyteller(chronicle_id) or public.npc_revealed_to_me(id));
create policy "storytellers add NPCs" on public.npcs
  for insert to authenticated with check (public.is_storyteller(chronicle_id));
create policy "storytellers edit NPCs" on public.npcs
  for update to authenticated using (public.is_storyteller(chronicle_id))
  with check (public.is_storyteller(chronicle_id));
create policy "storytellers delete NPCs" on public.npcs
  for delete to authenticated using (public.is_storyteller(chronicle_id));

create policy "only storytellers see NPC secrets" on public.npc_secrets
  for select to authenticated using (public.is_storyteller(chronicle_id));
create policy "only storytellers edit NPC secrets" on public.npc_secrets
  for update to authenticated using (public.is_storyteller(chronicle_id))
  with check (public.is_storyteller(chronicle_id));

create policy "storytellers and revealed players see handouts" on public.handouts
  for select to authenticated using (public.is_storyteller(chronicle_id) or public.handout_revealed_to_me(id));
create policy "storytellers add handouts" on public.handouts
  for insert to authenticated with check (public.is_storyteller(chronicle_id));
create policy "storytellers edit handouts" on public.handouts
  for update to authenticated using (public.is_storyteller(chronicle_id))
  with check (public.is_storyteller(chronicle_id));
create policy "storytellers delete handouts" on public.handouts
  for delete to authenticated using (public.is_storyteller(chronicle_id));

create policy "players see what was revealed to them" on public.reveals
  for select to authenticated
  using (public.is_storyteller(chronicle_id) or user_id = auth.uid()
         or (table_id is not null and public.is_seated(table_id)));
create policy "storytellers reveal" on public.reveals
  for insert to authenticated
  with check (public.is_storyteller(chronicle_id) and revealed_by = auth.uid());
create policy "storytellers hide again" on public.reveals
  for delete to authenticated using (public.is_storyteller(chronicle_id));

create policy "the table sees its rolls, private ones only the roller and storytellers" on public.rolls
  for select to authenticated
  using (public.at_table(table_id)
         and (not private or user_id = auth.uid() or public.is_storyteller(chronicle_id)));

create policy "the table sees its music and spotlight" on public.table_state
  for select to authenticated using (public.at_table(table_id));

create policy "storytellers see the playlist" on public.tracks
  for select to authenticated using (public.is_storyteller(chronicle_id));
create policy "storytellers add tracks" on public.tracks
  for insert to authenticated with check (public.is_storyteller(chronicle_id));
create policy "storytellers edit tracks" on public.tracks
  for update to authenticated using (public.is_storyteller(chronicle_id))
  with check (public.is_storyteller(chronicle_id));
create policy "storytellers delete tracks" on public.tracks
  for delete to authenticated using (public.is_storyteller(chronicle_id));

-- Table privileges: the anonymous role gets nothing, signed-in users may read (row level
-- security picks the rows), and columns that RPCs own (ids, owners, chronicle links,
-- sheet data) can't be changed through plain updates. Reads are granted here instead of
-- relying on the platform's default privileges, which a hosted project may not have.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;

grant update (display_name) on public.profiles to authenticated;
grant update (name, description) on public.chronicles to authenticated;
grant delete on public.chronicles to authenticated;
grant update (name) on public.game_tables to authenticated;
grant delete on public.game_tables to authenticated;
grant update (name, portrait_path) on public.characters to authenticated;
grant delete on public.characters to authenticated;
grant insert (chronicle_id, name, title, clan, description) on public.npcs to authenticated;
grant update (name, title, clan, description, portrait_path) on public.npcs to authenticated;
grant delete on public.npcs to authenticated;
grant update (notes, hunger, pools) on public.npc_secrets to authenticated;
grant insert (chronicle_id, title, kind, body) on public.handouts to authenticated;
grant update (title, body, file_path) on public.handouts to authenticated;
grant delete on public.handouts to authenticated;
grant insert (chronicle_id, npc_id, handout_id, table_id, user_id, revealed_by) on public.reveals to authenticated;
grant delete on public.reveals to authenticated;
grant insert (chronicle_id, title, video_id, mood) on public.tracks to authenticated;
grant update (title, video_id, mood) on public.tracks to authenticated;
grant delete on public.tracks to authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
                                nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                                'Player'), 40));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger characters_touch before update on public.characters
  for each row execute function public.touch_updated_at();
create trigger npcs_touch before update on public.npcs
  for each row execute function public.touch_updated_at();
create trigger handouts_touch before update on public.handouts
  for each row execute function public.touch_updated_at();

create function public.npc_add_secrets() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.npc_secrets (npc_id, chronicle_id) values (new.id, new.chronicle_id);
  return new;
end $$;
create trigger npcs_add_secrets after insert on public.npcs
  for each row execute function public.npc_add_secrets();

-- ---------------------------------------------------------------------------
-- Small utilities
-- ---------------------------------------------------------------------------

-- 12 characters from an alphabet without look-alikes (no i, l, o, 0, 1).
create function public.new_invite_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  bytes bytea := extensions.gen_random_bytes(12);
  code text := '';
begin
  for i in 0..11 loop
    code := code || substr(alphabet, 1 + get_byte(bytes, i) % 31, 1);
  end loop;
  return code;
end $$;

-- Milliseconds since the epoch on the database clock; clients align music to it.
create function public.server_now() returns double precision
language sql volatile set search_path = '' as $$
  select extract(epoch from clock_timestamp()) * 1000;
$$;

create function public.d10() returns int
language sql volatile set search_path = '' as $$
  select 1 + floor(random() * 10)::int;
$$;

create function public.roll_d10s(n int) returns int[]
language sql volatile set search_path = '' as $$
  select coalesce(array_agg(public.d10()), '{}') from generate_series(1, greatest(n, 0));
$$;

-- An integer from a JSON value (number or numeric string), clamped; dflt when absent or junk.
create function public.jint(v jsonb, lo int, hi int, dflt int) returns int
language plpgsql immutable set search_path = '' as $$
declare
  n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then return dflt; end if;
  if jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
  elsif jsonb_typeof(v) = 'string' and btrim(v #>> '{}') ~ '^-?[0-9]{1,6}(\.[0-9]+)?$' then
    n := btrim(v #>> '{}')::numeric;
  else
    return dflt;
  end if;
  return greatest(lo, least(hi, floor(n)::int));
end $$;

-- ---------------------------------------------------------------------------
-- The V5 sheet: field names, validation, traits
-- (names and arithmetic only; no rules text lives here)
-- ---------------------------------------------------------------------------

create function public.v5_attributes() returns text[]
language sql immutable set search_path = '' as $$
  select array['strength', 'dexterity', 'stamina', 'charisma', 'manipulation', 'composure',
               'intelligence', 'wits', 'resolve'];
$$;

create function public.v5_skills() returns text[]
language sql immutable set search_path = '' as $$
  select array['Athletics', 'Brawl', 'Craft', 'Drive', 'Firearms', 'Larceny', 'Melee', 'Stealth', 'Survival',
               'Animal Ken', 'Etiquette', 'Insight', 'Intimidation', 'Leadership', 'Performance', 'Persuasion',
               'Streetwise', 'Subterfuge', 'Academics', 'Awareness', 'Finance', 'Investigation', 'Medicine',
               'Occult', 'Politics', 'Science', 'Technology'];
$$;

-- Top-level keys a sheet may carry. MundusMaker's vtm5 sheet keys plus a few this app adds
-- (stains, sect, rituals, health/willpower bonuses); MundusMaker keeps unknown keys on import.
create function public.v5_text_keys() returns text[]
language sql immutable set search_path = '' as $$
  select array['clan', 'predatorType', 'sire', 'ambition', 'desire', 'concept', 'chronicle', 'sect',
               'resonance', 'tenets', 'bane', 'bloodSurge', 'mendAmount', 'powerBonus', 'rouseReroll',
               'feedingPenalty', 'baneSeverity', 'trueAge', 'apparentAge', 'dateOfBirth', 'dateOfDeath',
               'appearance', 'features', 'history', 'notes'];
$$;

create function public.v5_list_keys() returns text[]
language sql immutable set search_path = '' as $$
  select array['specialties', 'disciplines', 'rituals', 'advantages', 'convictions', 'touchstones'];
$$;

-- Validates one value at a sheet path and returns it normalized; raises on anything else.
create function public.v5_value(p_path text[], v jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  top text := p_path[1];
  sub text := p_path[2];
  depth int := coalesce(array_length(p_path, 1), 0);
begin
  if depth = 1 then
    if top = any (public.v5_text_keys()) then
      if jsonb_typeof(v) = 'number' then return to_jsonb(v #>> '{}'); end if;
      if jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 20000 then
        raise exception 'sheet field % must be text', top using errcode = '22023';
      end if;
      return v;
    elsif top = any (public.v5_list_keys()) then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 200 then
        raise exception 'sheet field % must be a list', top using errcode = '22023';
      end if;
      return v;
    elsif top = 'generation' then return to_jsonb(public.jint(v, 1, 16, 13));
    elsif top = 'bloodPotency' then return to_jsonb(public.jint(v, 0, 10, 1));
    elsif top = 'hunger' then return to_jsonb(public.jint(v, 0, 5, 1));
    elsif top = 'humanity' then return to_jsonb(public.jint(v, 0, 10, 7));
    elsif top = 'stains' then return to_jsonb(public.jint(v, 0, 10, 0));
    elsif top in ('healthMaxBonus', 'willpowerMaxBonus') then return to_jsonb(public.jint(v, -5, 10, 0));
    elsif top in ('attributes', 'skills', 'health', 'willpower', 'xp') then
      if jsonb_typeof(v) <> 'object' then
        raise exception 'sheet field % must be an object', top using errcode = '22023';
      end if;
      return public.v5_object(top, v);
    end if;
  elsif depth = 2 then
    if top = 'attributes' and sub = any (public.v5_attributes()) then
      return to_jsonb(public.jint(v, 1, 5, 1));
    elsif top = 'skills' and sub = any (public.v5_skills()) then
      return to_jsonb(public.jint(v, 0, 5, 0));
    elsif top in ('health', 'willpower') and sub in ('superficial', 'aggravated') then
      return to_jsonb(public.jint(v, 0, 15, 0));
    elsif top = 'xp' and sub in ('total', 'spent') then
      return to_jsonb(public.jint(v, 0, 100000, 0));
    elsif top = 'xp' and sub = 'ledger' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 200 then
        raise exception 'the XP ledger must be a list' using errcode = '22023';
      end if;
      return v;
    end if;
  end if;
  raise exception 'unknown sheet field %', array_to_string(p_path, '.') using errcode = '22023';
end $$;

-- Normalizes one of the object-valued fields, dropping keys it doesn't know.
create function public.v5_object(top text, v jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  k text;
  x jsonb;
  out jsonb := '{}'::jsonb;
begin
  for k, x in select * from jsonb_each(v) loop
    begin
      out := out || jsonb_build_object(k, public.v5_value(array[top, k], x));
    exception when sqlstate '22023' then
      null; -- unknown attribute/skill names and the like are dropped
    end;
  end loop;
  return out;
end $$;

-- Normalizes a whole sheet (imports, replacements): known keys only, values clamped.
create function public.v5_sanitize(d jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  k text;
  x jsonb;
  out jsonb := '{}'::jsonb;
begin
  if d is null or jsonb_typeof(d) <> 'object' then
    raise exception 'the sheet must be a JSON object' using errcode = '22023';
  end if;
  for k, x in select * from jsonb_each(d) loop
    begin
      out := out || jsonb_build_object(k, public.v5_value(array[k], x));
    exception when sqlstate '22023' then
      null;
    end;
  end loop;
  return out;
end $$;

create function public.v5_health_max(d jsonb) returns int
language sql immutable set search_path = '' as $$
  select greatest(1, public.jint(d -> 'attributes' -> 'stamina', 1, 5, 1) + 3
                     + public.jint(d -> 'healthMaxBonus', -5, 10, 0));
$$;

create function public.v5_willpower_max(d jsonb) returns int
language sql immutable set search_path = '' as $$
  select greatest(1, public.jint(d -> 'attributes' -> 'composure', 1, 5, 1)
                     + public.jint(d -> 'attributes' -> 'resolve', 1, 5, 1)
                     + public.jint(d -> 'willpowerMaxBonus', -5, 10, 0));
$$;

-- One trait of a sheet: 'attr:<key>', 'skill:<Name>' or 'disc:<Name>' -> {name, value}.
create function public.v5_trait(d jsonb, t text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  kind text := split_part(t, ':', 1);
  wanted text := btrim(substr(t, char_length(kind) + 2));
  key text;
  disc jsonb;
begin
  if kind = 'attr' then
    select a into key from unnest(public.v5_attributes()) a where a = lower(wanted);
    if key is null then raise exception 'unknown attribute %', wanted using errcode = '22023'; end if;
    return jsonb_build_object('name', initcap(key), 'value', public.jint(d -> 'attributes' -> key, 0, 5, 1));
  elsif kind = 'skill' then
    select s into key from unnest(public.v5_skills()) s where lower(s) = lower(wanted);
    if key is null then raise exception 'unknown skill %', wanted using errcode = '22023'; end if;
    return jsonb_build_object('name', key, 'value', public.jint(d -> 'skills' -> key, 0, 5, 0));
  elsif kind = 'disc' then
    select e into disc from jsonb_array_elements(case when jsonb_typeof(d -> 'disciplines') = 'array'
                                                      then d -> 'disciplines' else '[]'::jsonb end) e
     where lower(btrim(e ->> 'name')) = lower(wanted) limit 1;
    if disc is null then raise exception 'this sheet has no discipline called %', wanted using errcode = '22023'; end if;
    return jsonb_build_object('name', disc ->> 'name', 'value', public.jint(disc -> 'rating', 0, 5, 0));
  end if;
  raise exception 'unknown trait %', t using errcode = '22023';
end $$;

-- ---------------------------------------------------------------------------
-- V5 dice
-- ---------------------------------------------------------------------------

-- The verdict for a set of dice. 6+ is a success; each pair of 10s adds two more
-- (a critical); a critical with a 10 on a hunger die is messy; a hunger 1 turns a
-- failure bestial. Without a difficulty the verdict reports what the dice say.
create function public.v5_eval(p_regular int[], p_hunger int[], p_difficulty int) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  dice int[] := coalesce(p_regular, '{}') || coalesce(p_hunger, '{}');
  tens int;
  successes int;
  critical boolean;
  messy boolean;
  beast boolean := 1 = any (coalesce(p_hunger, '{}'));
  outcome text;
begin
  select count(*) filter (where d = 10), count(*) filter (where d >= 6)
    into tens, successes from unnest(dice) d;
  successes := successes + 2 * (tens / 2);
  critical := tens >= 2;
  messy := critical and 10 = any (coalesce(p_hunger, '{}'));
  if p_difficulty is not null then
    if successes >= p_difficulty then
      outcome := case when messy then 'messy_critical' when critical then 'critical_win' else 'win' end;
    elsif beast then outcome := 'bestial_failure';
    elsif successes = 0 then outcome := 'total_failure';
    else outcome := 'failure';
    end if;
  else
    outcome := case when successes = 0 and beast then 'bestial_failure'
                    when successes = 0 then 'total_failure'
                    when messy then 'messy_critical'
                    when critical then 'critical'
                    else 'successes' end;
  end if;
  return jsonb_build_object(
    'successes', successes,
    'outcome', outcome,
    'flags', to_jsonb(array_remove(array[
        case when critical then 'critical' end,
        case when messy then 'messy' end,
        case when beast then 'bestial_risk' end], null)),
    'margin', case when p_difficulty is null then null else successes - p_difficulty end);
end $$;

-- Who a roll is shown as: the character, a revealed NPC, or the storyteller.
create function public.roller_name(p_table uuid, p_character uuid, p_npc uuid, p_as text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  shown text;
begin
  if nullif(btrim(coalesce(p_as, '')), '') is not null then return left(btrim(p_as), 60); end if;
  if p_character is not null then
    select name into shown from public.characters where id = p_character;
    return coalesce(shown, 'A character');
  end if;
  if p_npc is not null then
    -- a public NPC roll names the NPC only if that NPC was revealed to this table
    select n.name into shown from public.npcs n
     where n.id = p_npc
       and exists (select 1 from public.reveals r where r.npc_id = n.id and r.table_id = p_table);
    return coalesce(shown, 'The Storyteller');
  end if;
  select display_name into shown from public.profiles where id = auth.uid();
  return coalesce(shown, 'Someone');
end $$;

-- The context every roll needs: the table, the caller's rights, and the character
-- or NPC being rolled for (locked, because rolls can change hunger and willpower).
create function public.roll_context(p_table uuid, p_character uuid, p_npc uuid,
                                    out chronicle uuid, out storyteller boolean, out sheet jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  ch public.characters;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select g.chronicle_id into chronicle from public.game_tables g where g.id = p_table;
  if chronicle is null or not public.at_table(p_table) then
    raise exception 'you are not at this table' using errcode = '42501';
  end if;
  storyteller := public.is_storyteller(chronicle);
  if p_character is not null and p_npc is not null then
    raise exception 'roll for a character or an NPC, not both' using errcode = '22023';
  end if;
  if p_character is not null then
    select * into ch from public.characters where id = p_character for update;
    if ch.id is null or ch.chronicle_id <> chronicle then
      raise exception 'that character is not in this chronicle' using errcode = '42501';
    end if;
    if ch.owner_id <> auth.uid() and not storyteller then
      raise exception 'that is not your character' using errcode = '42501';
    end if;
    sheet := ch.data;
  elsif p_npc is not null then
    if not storyteller then raise exception 'only storytellers roll for NPCs' using errcode = '42501'; end if;
    if not exists (select 1 from public.npcs where id = p_npc and chronicle_id = chronicle) then
      raise exception 'that NPC is not in this chronicle' using errcode = '42501';
    end if;
  end if;
end $$;

-- A rouse check against a character, applied to its hunger. Returns the new roll row.
-- The Blood can't be roused on purpose at Hunger 5; a check forced on the character
-- there is still rolled, and calls for a hunger frenzy test.
create function public.do_rouse(p_table uuid, p_chronicle uuid, p_character uuid, p_label text,
                                p_reroll boolean, p_private boolean, p_forced boolean) returns public.rolls
language plpgsql security definer set search_path = '' as $$
declare
  d jsonb;
  hunger int;
  dice int[] := array[public.d10()];
  ok boolean;
  effect text;
  r public.rolls;
begin
  select data into d from public.characters where id = p_character;
  hunger := public.jint(d -> 'hunger', 0, 5, 1);
  if hunger >= 5 and not coalesce(p_forced, false) then
    raise exception 'at Hunger 5 the Blood can''t be roused on purpose' using errcode = '22023';
  end if;
  ok := dice[1] >= 6;
  if not ok and p_reroll then
    dice := dice || public.d10();
    ok := dice[2] >= 6;
  end if;
  if hunger >= 5 then
    effect := 'Hunger 5: make a hunger frenzy test at Difficulty 4';
  elsif ok then
    effect := 'Hunger stays at ' || hunger;
  else
    update public.characters set data = jsonb_set(data, '{hunger}', to_jsonb(hunger + 1))
     where id = p_character;
    effect := 'Hunger ' || hunger || ' → ' || (hunger + 1);
  end if;
  insert into public.rolls (table_id, chronicle_id, user_id, character_id, who, kind, label, parts, pool,
                            hunger, regular, successes, outcome, flags, effect, private)
  values (p_table, p_chronicle, auth.uid(), p_character, public.roller_name(p_table, p_character, null, null),
          'rouse', coalesce(nullif(btrim(coalesce(p_label, '')), ''), 'Rouse check'),
          '[]'::jsonb, 1, hunger, dice, case when ok then 1 else 0 end,
          case when ok then 'rouse_ok' else 'rouse_fail' end,
          case when p_reroll and array_length(dice, 1) = 2 then array['rerolled'] else '{}' end,
          effect, coalesce(p_private, false))
  returning * into r;
  return r;
end $$;

-- Roll a dice pool at a table.
--   p_traits: up to three of 'attr:<key>', 'skill:<Name>', 'disc:<Name>' read from the sheet
--   p_pool:   a free pool size instead of traits ("roll five dice")
--   p_surge:  Blood Surge; makes a rouse check first, then adds dice: the number written in
--             the sheet's Blood Surge box, else half the Blood Potency rounded up (none at 0)
-- Hunger dice come from the character's sheet; p_hunger only applies to rolls without one.
create function public.roll_pool(
  p_table uuid,
  p_character uuid default null,
  p_traits text[] default '{}',
  p_modifier int default 0,
  p_specialty text default null,
  p_surge boolean default false,
  p_pool int default null,
  p_hunger int default null,
  p_difficulty int default null,
  p_label text default null,
  p_private boolean default false,
  p_npc uuid default null,
  p_as text default null
) returns public.rolls
language plpgsql security definer set search_path = '' as $$
declare
  ctx record;
  parts jsonb := '[]'::jsonb;
  t text;
  trait jsonb;
  total int := 0;
  surge_dice int;
  hunger int;
  pool int;
  regular int[];
  hdice int[];
  verdict jsonb;
  label text;
  r public.rolls;
begin
  select * into ctx from public.roll_context(p_table, p_character, p_npc);
  if p_difficulty is not null and (p_difficulty < 1 or p_difficulty > 15) then
    raise exception 'difficulty must be between 1 and 15' using errcode = '22023';
  end if;
  if p_as is not null and not ctx.storyteller then p_as := null; end if;

  if p_pool is not null then
    total := greatest(0, least(p_pool, 30));
    parts := jsonb_build_array(jsonb_build_object('name', 'Dice', 'value', total));
  else
    if p_character is null then
      raise exception 'choose a character to roll its traits, or roll a free pool' using errcode = '22023';
    end if;
    if coalesce(array_length(p_traits, 1), 0) = 0 or array_length(p_traits, 1) > 3 then
      raise exception 'pick one to three traits' using errcode = '22023';
    end if;
    foreach t in array p_traits loop
      trait := public.v5_trait(ctx.sheet, t);
      parts := parts || jsonb_build_array(trait);
      total := total + (trait ->> 'value')::int;
    end loop;
  end if;

  if coalesce(p_modifier, 0) <> 0 then
    p_modifier := greatest(-10, least(10, p_modifier));
    parts := parts || jsonb_build_array(jsonb_build_object('name', 'Modifier', 'value', p_modifier));
    total := total + p_modifier;
  end if;
  if nullif(btrim(coalesce(p_specialty, '')), '') is not null then
    parts := parts || jsonb_build_array(jsonb_build_object('name', 'Specialty: ' || left(btrim(p_specialty), 60), 'value', 1));
    total := total + 1;
  end if;

  if p_surge then
    if p_character is null then
      raise exception 'Blood Surge needs a character' using errcode = '22023';
    end if;
    if p_pool is null and not exists (select 1 from unnest(p_traits) x where x like 'attr:%') then
      raise exception 'Blood Surge adds to a pool that includes an Attribute' using errcode = '22023';
    end if;
    surge_dice := public.jint(to_jsonb(substring(coalesce(ctx.sheet ->> 'bloodSurge', '') from '[0-9]+')), 0, 10, 0);
    if surge_dice < 1 then
      surge_dice := (public.jint(ctx.sheet -> 'bloodPotency', 0, 10, 1) + 1) / 2;
    end if;
    if surge_dice < 1 then
      raise exception 'at Blood Potency 0 there is no Blood Surge' using errcode = '22023';
    end if;
    perform public.do_rouse(p_table, ctx.chronicle, p_character, 'Rouse check for Blood Surge', false, p_private, false);
    parts := parts || jsonb_build_array(jsonb_build_object('name', 'Blood Surge', 'value', surge_dice));
    total := total + surge_dice;
  end if;

  pool := greatest(1, least(total, 30));
  if p_character is not null then
    select public.jint(data -> 'hunger', 0, 5, 1) into hunger from public.characters where id = p_character;
  elsif p_npc is not null and p_hunger is null then
    select s.hunger into hunger from public.npc_secrets s where s.npc_id = p_npc;
  else
    hunger := greatest(0, least(coalesce(p_hunger, 0), 5));
  end if;
  hunger := least(coalesce(hunger, 0), pool);

  regular := public.roll_d10s(pool - hunger);
  hdice := public.roll_d10s(hunger);
  verdict := public.v5_eval(regular, hdice, p_difficulty);

  select coalesce(nullif(btrim(coalesce(p_label, '')), ''), string_agg(p ->> 'name', ' + '))
    into label from jsonb_array_elements(parts) p
   where p_label is not null or (p ->> 'name') <> 'Modifier';
  label := left(coalesce(label, 'Dice'), 120);

  insert into public.rolls (table_id, chronicle_id, user_id, character_id, npc_id, who, kind, label, parts,
                            pool, hunger, difficulty, regular, hunger_dice, successes, outcome, flags, private)
  values (p_table, ctx.chronicle, auth.uid(), p_character, p_npc,
          public.roller_name(p_table, p_character, p_npc, p_as), 'pool', label, parts,
          pool, hunger, p_difficulty, regular, hdice, (verdict ->> 'successes')::int, verdict ->> 'outcome',
          array(select jsonb_array_elements_text(verdict -> 'flags')), coalesce(p_private, false))
  returning * into r;
  return r;
end $$;

-- A rouse check at the table (powers, waking up, feeding attempts...).
-- p_reroll rolls a failed check once more, for powers within Blood Potency's re-roll level.
-- p_forced marks a check something else imposed, which is still rolled at Hunger 5.
create function public.rouse_check(p_table uuid, p_character uuid, p_label text default null,
                                   p_reroll boolean default false, p_private boolean default false,
                                   p_forced boolean default false)
returns public.rolls
language plpgsql security definer set search_path = '' as $$
declare
  ctx record;
begin
  if p_character is null then raise exception 'choose a character' using errcode = '22023'; end if;
  select * into ctx from public.roll_context(p_table, p_character, null);
  return public.do_rouse(p_table, ctx.chronicle, p_character, p_label, coalesce(p_reroll, false), p_private,
                         coalesce(p_forced, false));
end $$;

-- A roll of a tracker: current (undamaged) Willpower, Humanity, or a frenzy test
-- (Willpower plus a third of Humanity, rounded down). Never Hunger dice, never re-rolled.
create function public.tracker_roll(p_table uuid, p_character uuid, p_tracker text,
                                    p_difficulty int default null, p_private boolean default false)
returns public.rolls
language plpgsql security definer set search_path = '' as $$
declare
  ctx record;
  wp int;
  humanity int;
  pool int;
  parts jsonb;
  label text;
  dice int[];
  verdict jsonb;
  r public.rolls;
begin
  if p_character is null then raise exception 'choose a character' using errcode = '22023'; end if;
  if p_difficulty is not null and (p_difficulty < 1 or p_difficulty > 15) then
    raise exception 'difficulty must be between 1 and 15' using errcode = '22023';
  end if;
  select * into ctx from public.roll_context(p_table, p_character, null);
  wp := public.v5_willpower_max(ctx.sheet)
        - public.jint(ctx.sheet -> 'willpower' -> 'superficial', 0, 15, 0)
        - public.jint(ctx.sheet -> 'willpower' -> 'aggravated', 0, 15, 0);
  humanity := public.jint(ctx.sheet -> 'humanity', 0, 10, 7);
  if p_tracker = 'willpower' then
    label := 'Willpower';
    parts := jsonb_build_array(jsonb_build_object('name', 'Willpower', 'value', greatest(wp, 0)));
    pool := wp;
  elsif p_tracker = 'humanity' then
    label := 'Humanity';
    parts := jsonb_build_array(jsonb_build_object('name', 'Humanity', 'value', humanity));
    pool := humanity;
  elsif p_tracker = 'frenzy' then
    label := 'Resist frenzy';
    parts := jsonb_build_array(jsonb_build_object('name', 'Willpower', 'value', greatest(wp, 0)),
                               jsonb_build_object('name', 'Humanity ÷ 3', 'value', humanity / 3));
    pool := wp + humanity / 3;
  else
    raise exception 'roll willpower, humanity or frenzy' using errcode = '22023';
  end if;
  pool := greatest(1, least(pool, 30));
  dice := public.roll_d10s(pool);
  verdict := public.v5_eval(dice, '{}', p_difficulty);
  insert into public.rolls (table_id, chronicle_id, user_id, character_id, who, kind, label, parts, pool,
                            difficulty, regular, successes, outcome, flags, private)
  values (p_table, ctx.chronicle, auth.uid(), p_character, public.roller_name(p_table, p_character, null, null),
          'tracker', label, parts, pool, p_difficulty, dice, (verdict ->> 'successes')::int,
          verdict ->> 'outcome', array(select jsonb_array_elements_text(verdict -> 'flags')),
          coalesce(p_private, false))
  returning * into r;
  return r;
end $$;

-- Storytellers can set (or clear) the Difficulty of a roll after it was made; the
-- verdict is worked out again from the same dice.
create function public.set_roll_difficulty(p_roll uuid, p_difficulty int) returns public.rolls
language plpgsql security definer set search_path = '' as $$
declare
  old public.rolls;
  verdict jsonb;
  r public.rolls;
begin
  select * into old from public.rolls where id = p_roll for update;
  if old.id is null or not public.is_storyteller(old.chronicle_id) then
    raise exception 'only storytellers set difficulties' using errcode = '42501';
  end if;
  if old.kind not in ('pool', 'reroll', 'tracker') then
    raise exception 'rouse and remorse checks have no difficulty' using errcode = '22023';
  end if;
  if p_difficulty is not null and (p_difficulty < 1 or p_difficulty > 15) then
    raise exception 'difficulty must be between 1 and 15' using errcode = '22023';
  end if;
  verdict := public.v5_eval(old.regular, old.hunger_dice, p_difficulty);
  update public.rolls
     set difficulty = p_difficulty, successes = (verdict ->> 'successes')::int, outcome = verdict ->> 'outcome',
         flags = array(select jsonb_array_elements_text(verdict -> 'flags'))
   where id = p_roll
  returning * into r;
  return r;
end $$;

-- Remorse: one die per Humanity box that is neither filled nor stained (at least one).
-- Any success keeps Humanity; a failure costs one dot. The stains clear either way.
create function public.remorse_check(p_table uuid, p_character uuid, p_private boolean default false)
returns public.rolls
language plpgsql security definer set search_path = '' as $$
declare
  ctx record;
  humanity int;
  stains int;
  n int;
  dice int[];
  ok boolean;
  effect text;
  r public.rolls;
begin
  if p_character is null then raise exception 'choose a character' using errcode = '22023'; end if;
  select * into ctx from public.roll_context(p_table, p_character, null);
  humanity := public.jint(ctx.sheet -> 'humanity', 0, 10, 7);
  stains := public.jint(ctx.sheet -> 'stains', 0, 10, 0);
  n := greatest(1, 10 - humanity - stains);
  dice := public.roll_d10s(n);
  ok := exists (select 1 from unnest(dice) d where d >= 6);
  if ok then
    effect := 'Humanity stays at ' || humanity || '; stains cleared';
    update public.characters set data = jsonb_set(data, '{stains}', '0') where id = p_character;
  else
    effect := 'Humanity ' || humanity || ' → ' || greatest(0, humanity - 1) || '; stains cleared';
    update public.characters
       set data = jsonb_set(jsonb_set(data, '{stains}', '0'), '{humanity}', to_jsonb(greatest(0, humanity - 1)))
     where id = p_character;
  end if;
  insert into public.rolls (table_id, chronicle_id, user_id, character_id, who, kind, label, parts, pool,
                            regular, successes, outcome, effect, private)
  values (p_table, ctx.chronicle, auth.uid(), p_character, public.roller_name(p_table, p_character, null, null),
          'remorse', 'Remorse check',
          jsonb_build_array(jsonb_build_object('name', 'Unmarked Humanity boxes', 'value', n)),
          n, dice, (select count(*) from unnest(dice) d where d >= 6)::int,
          case when ok then 'remorse_ok' else 'remorse_fail' end, effect, coalesce(p_private, false))
  returning * into r;
  return r;
end $$;

-- Spend Willpower to re-roll up to three regular dice of your own pool roll, once.
-- The character takes one superficial Willpower damage (a full track turns one
-- superficial into aggravated; an all-aggravated track can't pay).
create function public.willpower_reroll(p_roll uuid, p_dice int[]) returns public.rolls
language plpgsql security definer set search_path = '' as $$
declare
  old public.rolls;
  d jsonb;
  wmax int;
  sup int;
  agg int;
  effect text := null;
  regular int[];
  i int;
  verdict jsonb;
  r public.rolls;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into old from public.rolls where id = p_roll for update;
  if old.id is null or not public.at_table(old.table_id) then
    raise exception 'roll not found' using errcode = '42501';
  end if;
  if old.user_id is distinct from auth.uid() then
    raise exception 'only the player who rolled can re-roll it' using errcode = '42501';
  end if;
  if old.kind <> 'pool' then raise exception 'only dice pools can be re-rolled' using errcode = '22023'; end if;
  if old.rerolled then raise exception 'this roll was already re-rolled' using errcode = '22023'; end if;
  if coalesce(array_length(p_dice, 1), 0) not between 1 and 3 then
    raise exception 'pick one to three regular dice' using errcode = '22023';
  end if;
  if (select count(distinct x) from unnest(p_dice) x) <> array_length(p_dice, 1)
     or exists (select 1 from unnest(p_dice) x where x < 1 or x > coalesce(array_length(old.regular, 1), 0)) then
    raise exception 'those are not regular dice of this roll (hunger dice cannot be re-rolled)' using errcode = '22023';
  end if;

  if old.character_id is not null then
    select data into d from public.characters where id = old.character_id for update;
    wmax := public.v5_willpower_max(d);
    sup := public.jint(d -> 'willpower' -> 'superficial', 0, 15, 0);
    agg := public.jint(d -> 'willpower' -> 'aggravated', 0, 15, 0);
    if agg >= wmax then
      raise exception 'Willpower is exhausted: every box is aggravated' using errcode = '22023';
    elsif sup + agg < wmax then
      sup := sup + 1;
      effect := 'Willpower: 1 superficial damage';
    else
      sup := sup - 1;
      agg := agg + 1;
      effect := 'Willpower track full: 1 superficial became aggravated';
    end if;
    update public.characters
       set data = jsonb_set(data, '{willpower}',
                            coalesce(case when jsonb_typeof(data -> 'willpower') = 'object' then data -> 'willpower' end, '{}'::jsonb)
                            || jsonb_build_object('superficial', sup, 'aggravated', agg))
     where id = old.character_id;
  end if;

  regular := old.regular;
  foreach i in array p_dice loop
    regular[i] := public.d10();
  end loop;
  verdict := public.v5_eval(regular, old.hunger_dice, old.difficulty);
  update public.rolls set rerolled = true where id = old.id;
  insert into public.rolls (table_id, chronicle_id, user_id, character_id, npc_id, who, kind, label, parts,
                            pool, hunger, difficulty, regular, hunger_dice, successes, outcome, flags,
                            effect, private, parent_id)
  values (old.table_id, old.chronicle_id, old.user_id, old.character_id, old.npc_id, old.who, 'reroll',
          old.label, old.parts || jsonb_build_array(jsonb_build_object('name', 'Re-rolled dice', 'value', p_dice)),
          old.pool, old.hunger, old.difficulty, regular, old.hunger_dice, (verdict ->> 'successes')::int,
          verdict ->> 'outcome', array(select jsonb_array_elements_text(verdict -> 'flags')),
          effect, old.private, old.id)
  returning * into r;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Chronicles, tables, invites, seats
-- ---------------------------------------------------------------------------

create function public.add_table(p_chronicle uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t uuid;
begin
  insert into public.game_tables (chronicle_id, name) values (p_chronicle, btrim(p_name)) returning id into t;
  insert into public.table_state (table_id, chronicle_id) values (t, p_chronicle);
  insert into public.table_invites (table_id, chronicle_id, code) values (t, p_chronicle, public.new_invite_code());
  return t;
end $$;

create function public.create_chronicle(p_name text, p_description text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  insert into public.chronicles (name, description, created_by)
  values (btrim(p_name), coalesce(p_description, ''), auth.uid()) returning id into c;
  insert into public.chronicle_members (chronicle_id, user_id, role) values (c, auth.uid(), 'storyteller');
  perform public.add_table(c, 'Main table');
  return c;
end $$;

create function public.create_table(p_chronicle uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_storyteller(p_chronicle) then
    raise exception 'only storytellers add tables' using errcode = '42501';
  end if;
  return public.add_table(p_chronicle, p_name);
end $$;

create function public.regenerate_invite(p_table uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
  code text := public.new_invite_code();
begin
  select chronicle_id into c from public.game_tables where id = p_table;
  if c is null or not public.is_storyteller(c) then
    raise exception 'only storytellers manage invites' using errcode = '42501';
  end if;
  insert into public.table_invites (table_id, chronicle_id, code) values (p_table, c, code)
  on conflict (table_id) do update set code = excluded.code, created_at = now();
  return code;
end $$;

create function public.disable_invite(p_table uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
begin
  select chronicle_id into c from public.game_tables where id = p_table;
  if c is null or not public.is_storyteller(c) then
    raise exception 'only storytellers manage invites' using errcode = '42501';
  end if;
  delete from public.table_invites where table_id = p_table;
end $$;

-- What an invite opens, so the join page can say where you're going before you join.
create function public.invite_info(p_code text)
returns table (chronicle_name text, table_name text)
language sql stable security definer set search_path = '' as $$
  select c.name, g.name
    from public.table_invites i
    join public.game_tables g on g.id = i.table_id
    join public.chronicles c on c.id = i.chronicle_id
   where i.code = lower(btrim(p_code)) and auth.uid() is not null;
$$;

create function public.join_table(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  inv public.table_invites;
  role public.member_role;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into inv from public.table_invites where code = lower(btrim(p_code));
  if inv.table_id is null then
    raise exception 'that invite link is not valid any more; ask your storyteller for a new one' using errcode = 'P0002';
  end if;
  insert into public.chronicle_members (chronicle_id, user_id, role)
  values (inv.chronicle_id, auth.uid(), 'player')
  on conflict (chronicle_id, user_id) do nothing;
  select m.role into role from public.chronicle_members m
   where m.chronicle_id = inv.chronicle_id and m.user_id = auth.uid();
  if role = 'player' then
    insert into public.seats (table_id, user_id, chronicle_id)
    values (inv.table_id, auth.uid(), inv.chronicle_id)
    on conflict (table_id, user_id) do nothing;
  end if;
  return inv.table_id;
end $$;

create function public.seat_member(p_table uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
begin
  select chronicle_id into c from public.game_tables where id = p_table;
  if c is null or not public.is_storyteller(c) then
    raise exception 'only storytellers seat players' using errcode = '42501';
  end if;
  insert into public.seats (table_id, user_id, chronicle_id) values (p_table, p_user, c)
  on conflict (table_id, user_id) do nothing;
end $$;

-- Storytellers unseat anyone; players can leave a table themselves.
create function public.unseat(p_table uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
begin
  select chronicle_id into c from public.game_tables where id = p_table;
  if c is null or not (public.is_storyteller(c) or p_user = auth.uid()) then
    raise exception 'only storytellers unseat other players' using errcode = '42501';
  end if;
  delete from public.seats where table_id = p_table and user_id = p_user;
end $$;

create function public.choose_character(p_table uuid, p_character uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
begin
  select chronicle_id into c from public.seats where table_id = p_table and user_id = auth.uid();
  if c is null then raise exception 'take a seat at this table first' using errcode = '42501'; end if;
  if p_character is not null and not exists (
       select 1 from public.characters
        where id = p_character and chronicle_id = c and owner_id = auth.uid()) then
    raise exception 'you can only play your own characters from this chronicle' using errcode = '42501';
  end if;
  update public.seats set character_id = p_character where table_id = p_table and user_id = auth.uid();
end $$;

create function public.set_member_role(p_chronicle uuid, p_user uuid, p_role public.member_role) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_storyteller(p_chronicle) then
    raise exception 'only storytellers change roles' using errcode = '42501';
  end if;
  if p_role = 'player' and (select count(*) from public.chronicle_members
                             where chronicle_id = p_chronicle and role = 'storyteller' and user_id <> p_user) = 0 then
    raise exception 'a chronicle needs at least one storyteller' using errcode = '22023';
  end if;
  update public.chronicle_members set role = p_role where chronicle_id = p_chronicle and user_id = p_user;
  if p_role = 'storyteller' then
    delete from public.seats where chronicle_id = p_chronicle and user_id = p_user;
  end if;
end $$;

-- Storytellers remove anyone; players can leave. Their seats and personal reveals go too;
-- their characters stay with the chronicle (storytellers still see them).
create function public.remove_member(p_chronicle uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_storyteller(p_chronicle) or (p_user = auth.uid() and public.is_member(p_chronicle))) then
    raise exception 'only storytellers remove other members' using errcode = '42501';
  end if;
  if (select role from public.chronicle_members where chronicle_id = p_chronicle and user_id = p_user) = 'storyteller'
     and (select count(*) from public.chronicle_members
           where chronicle_id = p_chronicle and role = 'storyteller' and user_id <> p_user) = 0 then
    raise exception 'a chronicle needs at least one storyteller; make someone else storyteller first' using errcode = '22023';
  end if;
  delete from public.chronicle_members where chronicle_id = p_chronicle and user_id = p_user;
end $$;

-- Seated players with the public face of the character they play.
create function public.table_roster(p_table uuid)
returns table (user_id uuid, display_name text, character_id uuid, character_name text,
               clan text, portrait_path text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.at_table(p_table) then
    raise exception 'you are not at this table' using errcode = '42501';
  end if;
  return query
    select s.user_id, p.display_name, c.id, c.name, coalesce(c.data ->> 'clan', ''), c.portrait_path
      from public.seats s
      join public.profiles p on p.id = s.user_id
      left join public.characters c on c.id = s.character_id
     where s.table_id = p_table
     order by p.display_name;
end $$;

-- ---------------------------------------------------------------------------
-- Characters
-- ---------------------------------------------------------------------------

create function public.create_character(p_chronicle uuid, p_name text, p_data jsonb,
                                        p_source text default 'manual', p_owner uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := coalesce(p_owner, auth.uid());
  ch uuid;
begin
  if not public.is_member(p_chronicle) then
    raise exception 'join the chronicle first' using errcode = '42501';
  end if;
  if owner <> auth.uid() and not (public.is_storyteller(p_chronicle) and exists (
       select 1 from public.chronicle_members where chronicle_id = p_chronicle and user_id = owner)) then
    raise exception 'only storytellers create characters for other members' using errcode = '42501';
  end if;
  insert into public.characters (chronicle_id, owner_id, name, data, source)
  values (p_chronicle, owner, btrim(p_name), public.v5_sanitize(coalesce(p_data, '{}'::jsonb)),
          coalesce(p_source, 'manual'))
  returning id into ch;
  return ch;
end $$;

create function public.replace_character_data(p_id uuid, p_data jsonb, p_source text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.characters;
begin
  select * into c from public.characters where id = p_id for update;
  if c.id is null or not ((c.owner_id = auth.uid() and public.is_member(c.chronicle_id))
                          or public.is_storyteller(c.chronicle_id)) then
    raise exception 'not your character' using errcode = '42501';
  end if;
  update public.characters
     set data = public.v5_sanitize(p_data), source = coalesce(p_source, source)
   where id = p_id
  returning data into c.data;
  return c.data;
end $$;

-- Change one field of a sheet atomically, so a click on a hunger dot and a rouse check
-- rolled at the same moment can't overwrite each other. Paths are one or two keys deep.
create function public.patch_character(p_id uuid, p_path text[], p_value jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.characters;
  v jsonb;
begin
  select * into c from public.characters where id = p_id for update;
  if c.id is null or not ((c.owner_id = auth.uid() and public.is_member(c.chronicle_id))
                          or public.is_storyteller(c.chronicle_id)) then
    raise exception 'not your character' using errcode = '42501';
  end if;
  if coalesce(array_length(p_path, 1), 0) not between 1 and 2 then
    raise exception 'bad sheet path' using errcode = '22023';
  end if;
  if pg_column_size(p_value) > 65536 then
    raise exception 'that value is too large' using errcode = '22023';
  end if;
  v := public.v5_value(p_path, p_value);
  if array_length(p_path, 1) = 2 and jsonb_typeof(c.data -> p_path[1]) is distinct from 'object' then
    c.data := jsonb_set(c.data, array[p_path[1]], '{}'::jsonb, true);
  end if;
  update public.characters set data = jsonb_set(c.data, p_path, v, true)
   where id = p_id
  returning data into c.data;
  return c.data;
end $$;

-- ---------------------------------------------------------------------------
-- Music and spotlight
-- ---------------------------------------------------------------------------

-- p_action: 'play' (a video), 'pause', 'resume', 'seek', 'loop', 'stop'.
-- State: {videoId, title, position (s), startedAt (server ms when position was taken),
--         playing, loop}. Clients play at position + (now - startedAt) / 1000.
create function public.set_music(p_table uuid, p_action text, p_video text default null,
                                 p_title text default null, p_position double precision default null,
                                 p_loop boolean default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
  m jsonb;
  now_ms double precision := public.server_now();
  pos double precision;
begin
  select chronicle_id, music into c, m from public.table_state where table_id = p_table for update;
  if c is null or not public.is_storyteller(c) then
    raise exception 'only storytellers control the music' using errcode = '42501';
  end if;
  if m is not null then
    pos := (m ->> 'position')::double precision
           + case when (m ->> 'playing')::boolean then (now_ms - (m ->> 'startedAt')::double precision) / 1000 else 0 end;
  end if;
  if p_action = 'play' then
    if p_video is null or p_video !~ '^[A-Za-z0-9_-]{11}$' then
      raise exception 'that is not a YouTube video id' using errcode = '22023';
    end if;
    m := jsonb_build_object('videoId', p_video, 'title', left(coalesce(p_title, ''), 120),
                            'position', greatest(0, coalesce(p_position, 0)), 'startedAt', now_ms,
                            'playing', true, 'loop', coalesce(p_loop, coalesce((m ->> 'loop')::boolean, true)));
  elsif m is null then
    return null;
  elsif p_action = 'pause' then
    m := m || jsonb_build_object('position', pos, 'startedAt', now_ms, 'playing', false);
  elsif p_action = 'resume' then
    m := m || jsonb_build_object('position', pos, 'startedAt', now_ms, 'playing', true);
  elsif p_action = 'seek' then
    m := m || jsonb_build_object('position', greatest(0, coalesce(p_position, 0)), 'startedAt', now_ms);
  elsif p_action = 'loop' then
    m := m || jsonb_build_object('loop', coalesce(p_loop, true));
  elsif p_action = 'stop' then
    m := null;
  else
    raise exception 'unknown music action %', p_action using errcode = '22023';
  end if;
  update public.table_state set music = m, updated_at = now() where table_id = p_table;
  return m;
end $$;

-- Show a handout to everyone at the table right now (revealing it to the table first).
create function public.spotlight_handout(p_table uuid, p_handout uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c uuid;
begin
  select chronicle_id into c from public.game_tables where id = p_table;
  if c is null or not public.is_storyteller(c) then
    raise exception 'only storytellers show handouts' using errcode = '42501';
  end if;
  if p_handout is not null then
    if not exists (select 1 from public.handouts where id = p_handout and chronicle_id = c) then
      raise exception 'that handout is not in this chronicle' using errcode = '42501';
    end if;
    insert into public.reveals (chronicle_id, handout_id, table_id, revealed_by)
    values (c, p_handout, p_table, auth.uid())
    on conflict do nothing;
  end if;
  update public.table_state
     set spotlight = case when p_handout is null then null
                          else jsonb_build_object('handoutId', p_handout, 'at', public.server_now()) end,
         updated_at = now()
   where table_id = p_table;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: one private bucket, paths <chronicle>/<characters|npcs|handouts>/<id>/<file>
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 10485760,
        array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do nothing;

create function public.media_parts(p text, out chronicle uuid, out kind text, out item uuid)
language plpgsql immutable set search_path = '' as $$
declare
  parts text[] := string_to_array(p, '/');
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(array_length(parts, 1), 0) <> 4 or parts[1] !~ uuid_re or parts[3] !~ uuid_re
     or parts[4] = '' or parts[2] not in ('characters', 'npcs', 'handouts') then
    return;
  end if;
  chronicle := parts[1]::uuid;
  kind := parts[2];
  item := parts[3]::uuid;
end $$;

create function public.media_readable(p text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  m record;
begin
  select * into m from public.media_parts(p);
  if m.chronicle is null then return false; end if;
  if m.kind = 'characters' then
    return public.is_member(m.chronicle)
       and exists (select 1 from public.characters where id = m.item and chronicle_id = m.chronicle);
  elsif m.kind = 'npcs' then
    return exists (select 1 from public.npcs where id = m.item and chronicle_id = m.chronicle)
       and (public.is_storyteller(m.chronicle) or public.npc_revealed_to_me(m.item));
  else
    return exists (select 1 from public.handouts where id = m.item and chronicle_id = m.chronicle)
       and (public.is_storyteller(m.chronicle) or public.handout_revealed_to_me(m.item));
  end if;
end $$;

create function public.media_writable(p text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  m record;
begin
  select * into m from public.media_parts(p);
  if m.chronicle is null then return false; end if;
  if m.kind = 'characters' then
    return exists (select 1 from public.characters c
                    where c.id = m.item and c.chronicle_id = m.chronicle
                      and ((c.owner_id = auth.uid() and public.is_member(m.chronicle))
                           or public.is_storyteller(m.chronicle)));
  elsif m.kind = 'npcs' then
    return public.is_storyteller(m.chronicle)
       and exists (select 1 from public.npcs where id = m.item and chronicle_id = m.chronicle);
  else
    return public.is_storyteller(m.chronicle)
       and exists (select 1 from public.handouts where id = m.item and chronicle_id = m.chronicle);
  end if;
end $$;

create policy "elysium media: read what you may see" on storage.objects
  for select to authenticated using (bucket_id = 'media' and public.media_readable(name));
create policy "elysium media: upload where you may write" on storage.objects
  for insert to authenticated with check (bucket_id = 'media' and public.media_writable(name));
create policy "elysium media: replace where you may write" on storage.objects
  for update to authenticated using (bucket_id = 'media' and public.media_writable(name))
  with check (bucket_id = 'media' and public.media_writable(name));
create policy "elysium media: delete where you may write" on storage.objects
  for delete to authenticated using (bucket_id = 'media' and public.media_writable(name));

-- ---------------------------------------------------------------------------
-- Function privileges: nothing for anon; internal helpers not callable at all
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.handle_new_user(), public.touch_updated_at(), public.npc_add_secrets(),
                           public.add_table(uuid, text),
                           public.do_rouse(uuid, uuid, uuid, text, boolean, boolean, boolean),
                           public.roll_context(uuid, uuid, uuid), public.roller_name(uuid, uuid, uuid, text),
                           public.d10(), public.roll_d10s(int), public.new_invite_code()
  from authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: tables the live table listens to (each event is filtered by the policies above)
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table
  public.rolls, public.table_state, public.reveals, public.seats, public.characters,
  public.npcs, public.handouts;
