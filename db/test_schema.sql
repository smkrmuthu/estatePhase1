-- Checks the database rules in schema.sql. Run against an empty database after loading it:
--   psql -v ON_ERROR_STOP=1 -d <db> -f schema.sql -f test_schema.sql
-- Everything runs in one transaction and is rolled back. Prints "ALL SCHEMA TESTS PASSED".
begin;

do $$
declare
  org uuid; g1 uuid; g2 uuid; it uuid; cl uuid; lt uuid; d uuid; ln uuid; t uuid; ok boolean;
  avail bigint;
begin
  insert into organisation (name) values ('Test Org') returning id into org;
  insert into location (organisation_id, code, name) values (org, 'G1', 'Main') returning id into g1;
  insert into location (organisation_id, code, name) values (org, 'G2', 'Town') returning id into g2;
  insert into item (organisation_id, code, name) values (org, 'ARA', 'Arabica Parchment') returning id into it;
  insert into client (organisation_id, code, name) values (org, 'C1', 'Curing Works') returning id into cl;
  insert into lot (organisation_id, code, item_id) values (org, 'LOT-1', it) returning id into lt;

  -- Receipt of 1000 kg / 20 bags.
  perform post_stock_txn(org, 'RECEIPT', 'RCV-1', current_date,
    jsonb_build_array(jsonb_build_object('location_id', g1, 'lot_id', lt, 'grams', 1000000, 'bags', 20)));
  select available_grams into avail from stock_balance where location_id = g1 and lot_id = lt;
  assert avail = 1000000, 'receipt should add stock';

  -- Transfer cannot overdraw; the failed posting leaves nothing behind.
  ok := false;
  begin
    perform post_stock_txn(org, 'TRANSFER', 'TRF-1', current_date, jsonb_build_array(
      jsonb_build_object('location_id', g1, 'lot_id', lt, 'grams', -1000001, 'bags', -1),
      jsonb_build_object('location_id', g2, 'lot_id', lt, 'grams', 1000001, 'bags', 1)));
  exception when check_violation then ok := true;
  end;
  assert ok, 'overdrawing transfer must fail';
  assert not exists (select 1 from stock_txn where no = 'TRF-1'), 'failed transfer must roll back';

  -- Adjustment requires a reason.
  ok := false;
  begin
    perform post_stock_txn(org, 'ADJUSTMENT', 'ADJ-1', current_date,
      jsonb_build_array(jsonb_build_object('location_id', g1, 'lot_id', lt, 'grams', -500, 'bags', 0)));
  exception when check_violation then ok := true;
  end;
  assert ok, 'adjustment without reason must fail';

  -- Draft dispatch of 300 kg / 6 bags holds stock.
  insert into dispatch (organisation_id, no, client_id, dispatch_date) values (org, 'DSP-1', cl, current_date) returning id into d;
  insert into dispatch_line (dispatch_id, line_no, location_id, lot_id, grams, bags, packages)
    values (d, 1, g1, lt, 300000, 6, 2) returning id into ln;
  insert into dispatch_package (dispatch_id, line_id, seq, barcode, grams, bags) values
    (d, ln, 1, 'PKG-AAAAAAAAAA1', 150000, 3),
    (d, ln, 2, 'PKG-AAAAAAAAAA2', 140000, 3);
  select available_grams into avail from stock_balance where location_id = g1 and lot_id = lt;
  assert avail = 700000, 'draft should reserve stock';

  -- Another posting cannot eat into the held stock.
  ok := false;
  begin
    perform post_stock_txn(org, 'ADJUSTMENT', 'ADJ-2', current_date,
      jsonb_build_array(jsonb_build_object('location_id', g1, 'lot_id', lt, 'grams', -700001, 'bags', 0)), '', 'Spillage');
  exception when check_violation then ok := true;
  end;
  assert ok, 'posting must respect draft holds';

  -- Packages that do not add up block posting.
  ok := false;
  begin perform post_dispatch(d); exception when others then ok := sqlerrm like 'Packages on line 1%'; end;
  assert ok, 'unreconciled packages must block posting';
  update dispatch_package set grams = 150000 where barcode = 'PKG-AAAAAAAAAA2';

  t := post_dispatch(d);
  assert (select status from dispatch where id = d) = 'DISPATCHED';
  assert (select count(*) from dispatch_package where dispatch_id = d and status = 'DISPATCHED') = 2;
  select on_hand_grams into avail from stock_balance where location_id = g1 and lot_id = lt;
  assert avail = 700000, 'posting should deduct stock';

  -- Barcodes are unique forever and cannot be changed or deleted.
  ok := false;
  begin insert into dispatch_package (dispatch_id, line_id, seq, barcode, grams, bags) values (d, ln, 3, 'PKG-AAAAAAAAAA1', 1, 0);
  exception when unique_violation then ok := true; end;
  assert ok, 'duplicate barcode must fail';
  ok := false;
  begin update dispatch_package set barcode = 'PKG-BBBBBBBBBB1' where barcode = 'PKG-AAAAAAAAAA1';
  exception when raise_exception then ok := true; end;
  assert ok, 'barcode must not change';
  ok := false;
  begin delete from dispatch_package where barcode = 'PKG-AAAAAAAAAA1';
  exception when raise_exception then ok := true; end;
  assert ok, 'package must not be deleted';

  -- Ledger is append-only.
  ok := false;
  begin update stock_ledger set grams = 1; exception when raise_exception then ok := true; end;
  assert ok, 'ledger update must fail';
  ok := false;
  begin delete from stock_ledger; exception when raise_exception then ok := true; end;
  assert ok, 'ledger delete must fail';

  -- Trace view resolves a barcode.
  assert (select client_name from package_trace where barcode = 'PKG-AAAAAAAAAA2') = 'Curing Works';

  -- Reversal restores stock, retires barcodes and cannot be repeated.
  perform reverse_dispatch(d, 'REV-1', 'Truck did not leave');
  select on_hand_grams into avail from stock_balance where location_id = g1 and lot_id = lt;
  assert avail = 1000000, 'reversal should restore stock';
  assert (select count(*) from dispatch_package where dispatch_id = d and status = 'CANCELLED') = 2;
  ok := false;
  begin perform reverse_dispatch(d, 'REV-2', 'again'); exception when others then ok := true; end;
  assert ok, 'double reversal must fail';

  raise notice 'ALL SCHEMA TESTS PASSED';
end $$;

rollback;
