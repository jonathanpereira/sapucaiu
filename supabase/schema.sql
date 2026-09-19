-- Sapucaiu no Samba — database schema
--
-- Run this once, top to bottom, in the Supabase SQL editor of a fresh
-- project (Dashboard → SQL Editor → New query → paste → Run). It is meant
-- to be idempotent-ish for re-running during setup (drops nothing that
-- already has data), but is not a migration framework — for a single
-- club app, this file *is* the schema.
--
-- ─── One-time project setup (do this in the Dashboard, not here) ───
-- 1. Create a project at supabase.com (free tier).
-- 2. Settings → API → copy "Project URL" and the "anon public" key into
--    config.js (SUPABASE_URL / SUPABASE_ANON_KEY).
-- 3. SQL Editor → run this whole file.
-- 4. Change the organizer PIN from the shipped default — see the bottom of
--    this file ("Setting a real PIN").
--
-- ─── Access model recap ───
-- There is no login for regular members (matches the prototype: pick your
-- name, no password) — `members`, `event_signups`, `rehearsal_attendance`
-- are directly readable/writable by the `anon` key. This means the API
-- trusts whatever member_id a request claims; it's the same trust model as
-- the prototype's shared arrays, just backed by a real shared database now.
--
-- `events` and `rehearsals` are read-only over the API. All writes to them
-- go through the two PIN-checked functions at the bottom
-- (organizer_save_event / organizer_delete_event) — the PIN never ships in
-- client source, and it's hashed at rest, so this is real enforcement, not
-- just a UI gate like in the prototype.

create extension if not exists pgcrypto;

-- ─── Tables ─────────────────────────────────────────────────────────────

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  date date,
  place text,
  treffpunkt text,
  maps_url text,
  ankunft text,
  showtime text,
  ende text,
  outfit text,
  setlist_url text,
  hinweise text,
  created_at timestamptz not null default now()
);

create table if not exists rehearsals (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  date date,
  time time,
  place text
);

create table if not exists event_signups (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  response text check (response in ('ja', 'nein', 'vielleicht')),
  comment text,
  does_tanz boolean not null default false,
  does_bateria boolean not null default false,
  instruments text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (member_id, event_id)
);

create table if not exists rehearsal_attendance (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members (id) on delete cascade,
  rehearsal_id uuid not null references rehearsals (id) on delete cascade,
  response text check (response in ('ja', 'nein', 'vielleicht')),
  updated_at timestamptz not null default now(),
  unique (member_id, rehearsal_id)
);

-- Holds the hashed organizer PIN only. RLS is enabled with zero policies
-- below, so nothing can ever read it through the API — only the
-- SECURITY DEFINER functions further down (running as the table owner)
-- can see it.
create table if not exists app_secrets (
  id boolean primary key default true, -- singleton row: exactly one PIN
  pin_hash text not null,
  constraint app_secrets_singleton check (id)
);

insert into app_secrets (id, pin_hash)
values (true, crypt('1312', gen_salt('bf')))
on conflict (id) do nothing;

-- ─── Realtime ────────────────────────────────────────────────────────────
-- Off by default per table on Supabase — without this, db.js's
-- subscribeToResponses() silently receives nothing and the Übersicht
-- screen only ever updates on manual navigation, not live.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'event_signups'
  ) then
    alter publication supabase_realtime add table event_signups;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rehearsal_attendance'
  ) then
    alter publication supabase_realtime add table rehearsal_attendance;
  end if;
end $$;

-- ─── Row Level Security ─────────────────────────────────────────────────

alter table members enable row level security;
alter table events enable row level security;
alter table rehearsals enable row level security;
alter table event_signups enable row level security;
alter table rehearsal_attendance enable row level security;
alter table app_secrets enable row level security; -- no policies → no API access at all

drop policy if exists "members are readable by anyone" on members;
create policy "members are readable by anyone" on members for select using (true);
drop policy if exists "anyone can register as a member" on members;
create policy "anyone can register as a member" on members for insert with check (true);

drop policy if exists "events are readable by anyone" on events;
create policy "events are readable by anyone" on events for select using (true);
-- no insert/update/delete policy: writes only via organizer_save_event / organizer_delete_event

drop policy if exists "rehearsals are readable by anyone" on rehearsals;
create policy "rehearsals are readable by anyone" on rehearsals for select using (true);
-- no insert/update/delete policy: written only as part of organizer_save_event

drop policy if exists "signups are readable by anyone" on event_signups;
create policy "signups are readable by anyone" on event_signups for select using (true);
drop policy if exists "anyone can write a signup" on event_signups;
create policy "anyone can write a signup" on event_signups for insert with check (true);
drop policy if exists "anyone can update a signup" on event_signups;
create policy "anyone can update a signup" on event_signups for update using (true) with check (true);

drop policy if exists "attendance is readable by anyone" on rehearsal_attendance;
create policy "attendance is readable by anyone" on rehearsal_attendance for select using (true);
drop policy if exists "anyone can write attendance" on rehearsal_attendance;
create policy "anyone can write attendance" on rehearsal_attendance for insert with check (true);
drop policy if exists "anyone can update attendance" on rehearsal_attendance;
create policy "anyone can update attendance" on rehearsal_attendance for update using (true) with check (true);

-- ─── PIN-gated organizer writes ─────────────────────────────────────────

create or replace function verify_pin(p_pin text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from app_secrets where id = true and pin_hash = crypt(p_pin, pin_hash)
  );
$$;
-- Also callable directly from the client (app.js calls it on the PIN
-- keypad's "OK" to decide unlock vs. "wrong PIN" — see db.js). It only ever
-- returns true/false, never the hash, so this doesn't weaken anything; it
-- just means changing the PIN via `update app_secrets ...` takes effect
-- immediately without a redeploy.
grant execute on function verify_pin(text) to anon, authenticated;

-- p_event: {"id": uuid|null, "title", "date" (yyyy-mm-dd), "place", "treffpunkt",
--           "maps_url", "ankunft", "showtime", "ende", "outfit", "setlist_url", "hinweise"}
-- p_rehearsals: [{"date", "time", "place"}, ...] — the full list; existing
-- rehearsal rows for this event are replaced wholesale, matching the
-- organizer form which always submits the complete list at once.
create or replace function organizer_save_event(p_pin text, p_event jsonb, p_rehearsals jsonb)
returns events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_event->>'id', '')::uuid;
  v_row events;
begin
  if not verify_pin(p_pin) then
    raise exception 'invalid pin';
  end if;

  if v_id is null then
    insert into events (title, date, place, treffpunkt, maps_url, ankunft, showtime, ende, outfit, setlist_url, hinweise)
    values (
      p_event->>'title', nullif(p_event->>'date', '')::date, p_event->>'place', p_event->>'treffpunkt',
      nullif(p_event->>'maps_url', ''), p_event->>'ankunft', p_event->>'showtime', p_event->>'ende',
      p_event->>'outfit', nullif(p_event->>'setlist_url', ''), p_event->>'hinweise'
    )
    returning * into v_row;
  else
    update events set
      title = p_event->>'title', date = nullif(p_event->>'date', '')::date, place = p_event->>'place',
      treffpunkt = p_event->>'treffpunkt', maps_url = nullif(p_event->>'maps_url', ''),
      ankunft = p_event->>'ankunft', showtime = p_event->>'showtime', ende = p_event->>'ende',
      outfit = p_event->>'outfit', setlist_url = nullif(p_event->>'setlist_url', ''),
      hinweise = p_event->>'hinweise'
    where id = v_id
    returning * into v_row;
  end if;

  delete from rehearsals where event_id = v_row.id;
  insert into rehearsals (event_id, date, time, place)
  select v_row.id, nullif(r->>'date', '')::date, nullif(r->>'time', '')::time, r->>'place'
  from jsonb_array_elements(coalesce(p_rehearsals, '[]'::jsonb)) r;

  return v_row;
end;
$$;
grant execute on function organizer_save_event(text, jsonb, jsonb) to anon, authenticated;

create or replace function organizer_delete_event(p_pin text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not verify_pin(p_pin) then
    raise exception 'invalid pin';
  end if;
  delete from events where id = p_id;
end;
$$;
grant execute on function organizer_delete_event(text, uuid) to anon, authenticated;

-- ─── Setting a real PIN ──────────────────────────────────────────────────
-- Run this in the SQL editor whenever you want to change it (replace 'NEWPIN'):
--   update app_secrets set pin_hash = crypt('NEWPIN', gen_salt('bf')) where id = true;

-- ─── Seed data ───────────────────────────────────────────────────────────
-- Same roster/events as the prototype, so the app isn't empty on first
-- load. Safe to run once; guarded so re-running this file doesn't duplicate
-- rows (members.name is unique; events are matched by title+date).

insert into members (name) values
  ('Ana Beatriz Rocha'), ('Bruno Kessler'), ('Carla Nunes'), ('Daniel Ostrowski'),
  ('Elif Yalçın'), ('Fernanda Lima'), ('Greta Hoffmann'), ('Hendrik Vogel'),
  ('Isabel Moreira'), ('Jonas Kraus'), ('Katja Brandt'), ('Lucas Ferreira'),
  ('Marcia Alves'), ('Nuno Batista'), ('Paula Wiedemann'), ('Sofia Duarte')
on conflict (name) do nothing;

do $$
declare
  v_event_id uuid;
begin
  if not exists (select 1 from events where title = 'Berlin Samba Parade') then
    insert into events (title, date, place, treffpunkt, maps_url, ankunft, showtime, outfit, setlist_url, hinweise)
    values ('Berlin Samba Parade', '2026-10-24', 'Kreuzberg', 'Hermannplatz, Ecke Urbanstraße',
      'https://maps.google.com/?q=Hermannplatz+Berlin', '10:30 Uhr', '13:15 Uhr · Startnummer 14',
      'Gelb-grüne Fantasia, weiße Schuhe', 'Setlist 2026 (Drive)',
      'Kontakt vor Ort: Marcia · +49 176 2233 118. Bitte pünktlich sein, der Zug startet exakt um 11:00.')
    returning id into v_event_id;
    insert into rehearsals (event_id, date, time, place) values
      (v_event_id, '2026-10-06', '19:30', 'Saal Weichselstraße'),
      (v_event_id, '2026-10-13', '19:30', 'Saal Weichselstraße'),
      (v_event_id, '2026-10-18', '14:00', 'Generalprobe Mauerpark'),
      (v_event_id, '2026-10-23', '18:00', 'Kurz-Check & Outfit');
  end if;

  if not exists (select 1 from events where title = 'Sambanacht im Ballhaus') then
    insert into events (title, date, place, treffpunkt, maps_url, ankunft, showtime, outfit, setlist_url, hinweise)
    values ('Sambanacht im Ballhaus', '2026-11-14', 'Ballhaus Rixdorf', 'Bühneneingang Hinterhof',
      'https://maps.google.com/?q=Ballhaus+Rixdorf+Berlin', '18:45 Uhr', '20:30 Uhr',
      'Schwarz mit gelbem Gürtel', 'Setlist Ballhaus (Drive)',
      'Kontakt vor Ort: Bruno · +49 151 8890 442. Umkleide im Hinterhof, Instrumente bleiben über Nacht im Saal.')
    returning id into v_event_id;
    insert into rehearsals (event_id, date, time, place) values
      (v_event_id, '2026-11-03', '19:30', 'Saal Weichselstraße'),
      (v_event_id, '2026-11-10', '19:30', 'Saal Weichselstraße');
  end if;

  if not exists (select 1 from events where title = 'Weihnachts-Roda') then
    insert into events (title, date, place, treffpunkt, ankunft, showtime, outfit, setlist_url, hinweise)
    values ('Weihnachts-Roda', '2026-12-11', 'Kulturbrauerei, Prenzlauer Berg', 'Kesselhaus, Seiteneingang',
      '17:30 Uhr', '19:00 Uhr', 'Freie Wahl, Vereins-Shirt', 'Roda-Repertoire',
      'Kontakt vor Ort: Katja · +49 170 3344 019. Kurzes Set, danach gemeinsames Essen im Kesselhaus.')
    returning id into v_event_id;
    insert into rehearsals (event_id, date, time, place) values
      (v_event_id, '2026-12-08', '19:30', 'Saal Weichselstraße');
  end if;

  if not exists (select 1 from events where title = 'Karneval der Kulturen') then
    insert into events (title, date, place, treffpunkt, ankunft, showtime, outfit, setlist_url, hinweise)
    values ('Karneval der Kulturen', '2026-05-24', 'Kreuzberg', 'Hermannplatz',
      '10:00 Uhr', '12:40 Uhr', 'Fantasia 2026', 'Setlist KdK', 'Kontakt vor Ort: Marcia.')
    returning id into v_event_id;
    insert into rehearsals (event_id, date, time, place) values
      (v_event_id, '2026-05-05', '19:30', 'Saal Weichselstraße'),
      (v_event_id, '2026-05-12', '19:30', 'Saal Weichselstraße'),
      (v_event_id, '2026-05-17', '14:00', 'Generalprobe Tempelhofer Feld'),
      (v_event_id, '2026-05-21', '19:00', 'Outfit-Check Weichselstraße');
  end if;

  if not exists (select 1 from events where title = 'Fête de la Musique') then
    insert into events (title, date, place, treffpunkt, ankunft, showtime, outfit, setlist_url, hinweise)
    values ('Fête de la Musique', '2026-06-21', 'Tempelhofer Feld', 'Eingang Oderstraße',
      '16:00 Uhr', '17:30 Uhr', 'Weiß & Gelb', 'Setlist Fête', 'Kontakt vor Ort: Jonas.')
    returning id into v_event_id;
    insert into rehearsals (event_id, date, time, place) values
      (v_event_id, '2026-06-09', '19:30', 'Saal Weichselstraße'),
      (v_event_id, '2026-06-16', '19:30', 'Saal Weichselstraße');
  end if;

  if not exists (select 1 from events where title = 'Sommerfest Kulturbrauerei') then
    insert into events (title, date, place, treffpunkt, ankunft, showtime, outfit, setlist_url, hinweise)
    values ('Sommerfest Kulturbrauerei', '2026-08-15', 'Prenzlauer Berg', 'Kesselhaus',
      '15:30 Uhr', '17:00 Uhr', 'Vereins-Shirt', 'Sommer-Set', 'Kontakt vor Ort: Bruno.')
    returning id into v_event_id;
    insert into rehearsals (event_id, date, time, place) values
      (v_event_id, '2026-08-04', '19:30', 'Saal Weichselstraße'),
      (v_event_id, '2026-08-11', '19:30', 'Saal Weichselstraße'),
      (v_event_id, '2026-08-13', '18:30', 'Kurzprobe Kesselhaus');
  end if;
end $$;
