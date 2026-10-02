-- ============================================================================
-- COFFEE STOCK & DISTRIBUTION — target database schema (PostgreSQL / Supabase)
--
-- Phase 1 runs in the browser (public/js/store.js). This file is the shared, multi-user
-- version of the same model, for when the app moves onto a database. It enforces in
-- the database the rules store.js enforces in the browser:
--   * stock_ledger rows are append-only (no UPDATE / DELETE);
--   * posting cannot take a godown + lot below zero, counting draft-dispatch holds;
--   * package barcodes are unique forever and packages are never deleted.
--
-- Quantities are whole grams (bigint) plus bag counts, as in the browser store.
--
-- ADDING EARLIER STEPS LATER (sourcing, cultivation, fermentation, processing)
--   * Add their own tables (estate_block, harvest_intake, fermentation_batch, processing_run …).
--   * New lots point at them through lot.source_type / lot.source_id.
--   * Processing that turns input lots into output lots adds a 'PROCESSING' txn_type value
--     plus a lot_link(parent_lot_id, child_lot_id, txn_id) table for genealogy.
--   * Nothing below (ledger, dispatch, package, barcode) has to change.
--
-- Row-level security (per organisation / per godown) is added when this is connected
-- to Supabase Auth; every table already carries organisation_id for that.
-- ============================================================================

create extension if not exists pgcrypto;

create type txn_type        as enum ('OPENING', 'RECEIPT', 'TRANSFER', 'ADJUSTMENT', 'DISPATCH', 'REVERSAL');
create type txn_status      as enum ('POSTED', 'REVERSED');
create type dispatch_status as enum ('DRAFT', 'DISPATCHED', 'CANCELLED', 'REVERSED');
create type package_status  as enum ('PREPARED', 'DISPATCHED', 'CANCELLED', 'RETURNED');
create type lot_source      as enum ('RECEIPT', 'PURCHASE', 'HARVEST', 'PROCESSING');

create table organisation (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  timezone   text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now()
);

-- Godowns today. parent_id + kind let later phases add stacks/bays, or estates/blocks
-- as non-stock locations, without a new table.
create table location (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisation(id),
  parent_id       uuid references location(id),
  kind            text not null default 'GODOWN',
  code            text not null,
  name            text not null,
  address         text not null default '',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (organisation_id, code)
);

create table item (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisation(id),
  code            text not null,
  name            text not null,
  coffee_type     text not null default '',   -- Arabica / Robusta
  form            text not null default '',   -- Parchment / Cherry / Clean
  grade           text not null default '',
  bag_kg          numeric(8, 2),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (organisation_id, code)
);

create table client (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisation(id),
  code            text not null,
  name            text not null,
  contact_person  text not null default '',
  phone           text not null default '',
  address         text not null default '',
  gstin           text not null default '',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (organisation_id, code)
);

create table lot (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisation(id),
  code            text not null,
  item_id         uuid not null references item(id),
  source_type     lot_source not null default 'RECEIPT',
  source_id       uuid,                         -- row in the future source table
  source_ref      text not null default '',     -- free-text reference for Phase 1
  crop_year       text not null default '',
  moisture_pct    numeric(5, 2) check (moisture_pct between 0 and 100),
  outturn_pct     numeric(5, 2) check (outturn_pct between 0 and 100),
  notes           text not null default '',
  created_at      timestamptz not null default now(),
  unique (organisation_id, code)
);

create table stock_txn (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisation(id),
  no              text not null,
  type            txn_type not null,
  status          txn_status not null default 'POSTED',
  effective_date  date not null,
  posted_at       timestamptz not null default now(),
  posted_by       uuid,                           -- auth user once login is connected
  reference       text not null default '',
  reason          text not null default '',
  notes           text not null default '',
  reverses_id     uuid unique references stock_txn(id),  -- a txn can be reversed once
  dispatch_id     uuid,
  unique (organisation_id, no),
  check (type <> 'ADJUSTMENT' or reason <> ''),
  check ((type = 'REVERSAL') = (reverses_id is not null))
);

create table stock_ledger (
  id          bigint generated always as identity primary key,
  txn_id      uuid not null references stock_txn(id),
  location_id uuid not null references location(id),
  lot_id      uuid not null references lot(id),
  grams       bigint not null,
  bags        integer not null,
  check (grams <> 0 or bags <> 0)
);
create index stock_ledger_bal_idx on stock_ledger (location_id, lot_id);
create index stock_ledger_txn_idx on stock_ledger (txn_id);

create table dispatch (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisation(id),
  no              text not null,
  status          dispatch_status not null default 'DRAFT',
  client_id       uuid not null references client(id),
  dispatch_date   date not null,
  destination     text not null default '',
  vehicle_no      text not null default '',
  transporter     text not null default '',
  driver_name     text not null default '',
  driver_phone    text not null default '',
  reference       text not null default '',
  notes           text not null default '',
  txn_id          uuid references stock_txn(id),
  created_at      timestamptz not null default now(),
  posted_at       timestamptz,
  status_reason   text not null default '',
  unique (organisation_id, no),
  check ((status = 'DRAFT' or status = 'CANCELLED') = (txn_id is null))
);
alter table stock_txn add foreign key (dispatch_id) references dispatch(id);

create table dispatch_line (
  id          uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references dispatch(id),
  line_no     integer not null,
  location_id uuid not null references location(id),
  lot_id      uuid not null references lot(id),
  grams       bigint not null check (grams > 0),
  bags        integer not null check (bags >= 0),
  packages    integer not null check (packages >= 1),
  unique (dispatch_id, line_no)
);
create index dispatch_line_lot_idx on dispatch_line (location_id, lot_id);

-- One row per physical package. barcode is unique for all time; retired packages
-- keep their row (status CANCELLED) so an old label still resolves.
create table dispatch_package (
  id           uuid primary key default gen_random_uuid(),
  dispatch_id  uuid not null references dispatch(id),
  line_id      uuid not null references dispatch_line(id),
  seq          integer not null,
  barcode      text not null unique check (barcode ~ '^PKG-[0-9A-Z]{11}$'),
  grams        bigint not null check (grams > 0),
  bags         integer not null check (bags >= 0),
  status       package_status not null default 'PREPARED',
  print_count  integer not null default 0,
  created_at   timestamptz not null default now(),
  dispatched_at timestamptz,
  cancelled_at timestamptz
);
create index dispatch_package_dispatch_idx on dispatch_package (dispatch_id);

create table audit_event (
  id              bigint generated always as identity primary key,
  organisation_id uuid not null references organisation(id),
  at              timestamptz not null default now(),
  actor           uuid,
  action          text not null,
  entity          text not null,
  entity_id       uuid,
  summary         text not null default ''
);

-- ---------------------------------------------------------------------------
-- Immutability: ledger rows and packages are never removed or rewritten.
-- ---------------------------------------------------------------------------
create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% rows cannot be %d', tg_table_name, lower(tg_op);
end $$;

create trigger stock_ledger_append_only before update or delete on stock_ledger
  for each row execute function forbid_change();
create trigger dispatch_package_no_delete before delete on dispatch_package
  for each row execute function forbid_change();
create trigger audit_event_append_only before update or delete on audit_event
  for each row execute function forbid_change();

create function package_barcode_fixed() returns trigger language plpgsql as $$
begin
  if new.barcode <> old.barcode or new.dispatch_id <> old.dispatch_id then
    raise exception 'A package barcode never changes once issued';
  end if;
  return new;
end $$;
create trigger dispatch_package_barcode_fixed before update on dispatch_package
  for each row execute function package_barcode_fixed();

-- ---------------------------------------------------------------------------
-- Balances: always computed from the ledger and open drafts — nothing to drift.
-- ---------------------------------------------------------------------------
create view stock_on_hand as
  select location_id, lot_id, sum(grams)::bigint as grams, sum(bags)::bigint as bags
  from stock_ledger group by location_id, lot_id;

create view stock_reserved as
  select l.location_id, l.lot_id, sum(l.grams)::bigint as grams, sum(l.bags)::bigint as bags
  from dispatch_line l join dispatch d on d.id = l.dispatch_id
  where d.status = 'DRAFT'
  group by l.location_id, l.lot_id;

create view stock_balance as
  select coalesce(h.location_id, r.location_id) as location_id,
         coalesce(h.lot_id, r.lot_id)           as lot_id,
         coalesce(h.grams, 0)                   as on_hand_grams,
         coalesce(h.bags, 0)                    as on_hand_bags,
         coalesce(r.grams, 0)                   as reserved_grams,
         coalesce(h.grams, 0) - coalesce(r.grams, 0) as available_grams,
         coalesce(h.bags, 0) - coalesce(r.bags, 0)   as available_bags
  from stock_on_hand h
  full join stock_reserved r on r.location_id = h.location_id and r.lot_id = h.lot_id;

-- ---------------------------------------------------------------------------
-- Posting. All writes to stock go through these functions so the checks always run.
-- ---------------------------------------------------------------------------

-- Serialises postings that touch the same godown + lot (concurrent users).
create function lock_balance(p_location uuid, p_lot uuid) returns void language sql as $$
  select pg_advisory_xact_lock(hashtextextended(p_location::text || p_lot::text, 0));
$$;

-- Fails if the godown + lot is negative, or below what draft dispatches hold
-- (ignoring p_except_dispatch, i.e. the dispatch being posted).
create function assert_stock(p_location uuid, p_lot uuid, p_except_dispatch uuid default null)
returns void language plpgsql as $$
declare h_g bigint; h_b bigint; r_g bigint; r_b bigint; lot_code text;
begin
  select coalesce(sum(grams), 0), coalesce(sum(bags), 0) into h_g, h_b
    from stock_ledger where location_id = p_location and lot_id = p_lot;
  select coalesce(sum(l.grams), 0), coalesce(sum(l.bags), 0) into r_g, r_b
    from dispatch_line l join dispatch d on d.id = l.dispatch_id
    where d.status = 'DRAFT' and l.location_id = p_location and l.lot_id = p_lot
      and d.id is distinct from p_except_dispatch;
  if h_g < 0 or h_b < 0 or h_g - r_g < 0 or h_b - r_b < 0 then
    select code into lot_code from lot where id = p_lot;
    raise exception 'Not enough stock of lot % (on hand % kg / % bags, held by drafts % kg)',
      lot_code, h_g / 1000.0, h_b, r_g / 1000.0 using errcode = 'check_violation';
  end if;
end $$;

-- p_entries: [{"location_id":…, "lot_id":…, "grams":…, "bags":…}, …] (signed quantities)
create function post_stock_txn(
  p_org uuid, p_type txn_type, p_no text, p_date date, p_entries jsonb,
  p_reference text default '', p_reason text default '', p_notes text default '',
  p_reverses uuid default null, p_dispatch uuid default null
) returns uuid language plpgsql as $$
declare t_id uuid; e jsonb;
begin
  if jsonb_array_length(p_entries) = 0 then raise exception 'A transaction needs at least one entry'; end if;
  for e in select * from jsonb_array_elements(p_entries) order by value->>'location_id', value->>'lot_id' loop
    perform lock_balance((e->>'location_id')::uuid, (e->>'lot_id')::uuid);
  end loop;
  insert into stock_txn (organisation_id, no, type, effective_date, reference, reason, notes, reverses_id, dispatch_id)
    values (p_org, p_no, p_type, p_date, p_reference, p_reason, p_notes, p_reverses, p_dispatch)
    returning id into t_id;
  insert into stock_ledger (txn_id, location_id, lot_id, grams, bags)
    select t_id, (x->>'location_id')::uuid, (x->>'lot_id')::uuid, (x->>'grams')::bigint, coalesce((x->>'bags')::int, 0)
    from jsonb_array_elements(p_entries) x;
  for e in select distinct on (value->>'location_id', value->>'lot_id') value from jsonb_array_elements(p_entries) loop
    perform assert_stock((e->>'location_id')::uuid, (e->>'lot_id')::uuid, p_dispatch);
  end loop;
  return t_id;
end $$;

create function reverse_stock_txn(p_txn uuid, p_no text, p_reason text) returns uuid language plpgsql as $$
declare t stock_txn; r_id uuid;
begin
  select * into t from stock_txn where id = p_txn for update;
  if t.id is null then raise exception 'Transaction not found'; end if;
  if t.status <> 'POSTED' or t.type = 'REVERSAL' then raise exception 'Transaction % cannot be reversed', t.no; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required to reverse a transaction'; end if;
  r_id := post_stock_txn(t.organisation_id, 'REVERSAL', p_no, current_date,
    (select jsonb_agg(jsonb_build_object('location_id', location_id, 'lot_id', lot_id, 'grams', -grams, 'bags', -bags))
       from stock_ledger where txn_id = t.id),
    t.no, p_reason, '', t.id, t.dispatch_id);
  update stock_txn set status = 'REVERSED' where id = t.id;
  return r_id;
end $$;

-- Posts a draft dispatch: checks packages reconcile to lines, deducts stock, finalises packages.
create function post_dispatch(p_dispatch uuid) returns uuid language plpgsql as $$
declare d dispatch; t_id uuid; bad record;
begin
  select * into d from dispatch where id = p_dispatch for update;
  if d.id is null then raise exception 'Dispatch not found'; end if;
  if d.status <> 'DRAFT' then raise exception 'Dispatch % is already %', d.no, lower(d.status::text); end if;
  select l.line_no into bad from dispatch_line l
    left join dispatch_package p on p.line_id = l.id and p.status <> 'CANCELLED'
    where l.dispatch_id = d.id
    group by l.id, l.line_no, l.grams, l.bags
    having coalesce(sum(p.grams), 0) <> l.grams or coalesce(sum(p.bags), 0) <> l.bags
    limit 1;
  if found then raise exception 'Packages on line % do not add up to the line total', bad.line_no; end if;
  t_id := post_stock_txn(d.organisation_id, 'DISPATCH', d.no, d.dispatch_date,
    (select jsonb_agg(jsonb_build_object('location_id', location_id, 'lot_id', lot_id, 'grams', -grams, 'bags', -bags))
       from dispatch_line where dispatch_id = d.id),
    '', '', d.notes, null, d.id);
  update dispatch set status = 'DISPATCHED', txn_id = t_id, posted_at = now() where id = d.id;
  update dispatch_package set status = 'DISPATCHED', dispatched_at = now()
    where dispatch_id = d.id and status = 'PREPARED';
  return t_id;
end $$;

create function reverse_dispatch(p_dispatch uuid, p_no text, p_reason text) returns uuid language plpgsql as $$
declare d dispatch; r_id uuid;
begin
  select * into d from dispatch where id = p_dispatch for update;
  if d.status is distinct from 'DISPATCHED' then raise exception 'Only dispatched dispatches can be reversed'; end if;
  r_id := reverse_stock_txn(d.txn_id, p_no, p_reason);
  update dispatch set status = 'REVERSED', status_reason = p_reason where id = d.id;
  update dispatch_package set status = 'CANCELLED', cancelled_at = now()
    where dispatch_id = d.id and status = 'DISPATCHED';
  return r_id;
end $$;

-- Package trace for a scanned barcode.
create view package_trace as
  select p.barcode, p.seq, p.status as package_status, p.grams, p.bags,
         d.no as dispatch_no, d.status as dispatch_status, d.dispatch_date, d.vehicle_no, d.driver_name, d.destination,
         c.name as client_name, lt.code as lot_code, lt.crop_year, lt.source_type, lt.source_ref,
         i.name as item_name, i.coffee_type, i.form, i.grade, g.name as godown_name,
         p.created_at, p.dispatched_at, p.cancelled_at
  from dispatch_package p
  join dispatch d       on d.id = p.dispatch_id
  join client c         on c.id = d.client_id
  join dispatch_line l  on l.id = p.line_id
  join lot lt           on lt.id = l.lot_id
  join item i           on i.id = lt.item_id
  join location g       on g.id = l.location_id;
