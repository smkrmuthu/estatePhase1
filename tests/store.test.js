// Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const Code128 = require("../public/js/code128.js");
const S = require("../public/js/store.js");

function fresh() {
  let text = null;
  S.useBackend({ read: () => text, write: t => { text = t; } });
  const g1 = S.saveGodown({ code: "G1", name: "Main" });
  const g2 = S.saveGodown({ code: "G2", name: "Town" });
  const it = S.saveItem({ code: "ARA", name: "Arabica Parchment" });
  const cl = S.saveClient({ code: "C1", name: "Curing Works", address: "Hassan" });
  return { g1, g2, it, cl, reload: () => S.useBackend({ read: () => text, write: t => { text = t; } }) };
}

const bal = (g, l) => S.balances().find(b => b.godownId === g && b.lotId === l) || { onHandGrams: 0, availableGrams: 0, onHandBags: 0 };

test("receipt creates a lot and on-hand stock", () => {
  const { g1, it } = fresh();
  const t = S.receive({ godownId: g1.id, itemId: it.id, kg: 1000.5, bags: 20 });
  assert.equal(t.no, `RCV-${S.today().slice(0, 4)}-00001`);
  const lot = S.state.lots[0];
  assert.match(lot.code, /^LOT-\d{4}-00001$/);
  assert.equal(lot.sourceType, "RECEIPT");
  assert.equal(bal(g1.id, lot.id).onHandGrams, 1000500);
  assert.equal(bal(g1.id, lot.id).onHandBags, 20);
});

test("receipt into an existing lot must match its item", () => {
  const { g1, it } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 100, bags: 2 });
  const other = S.saveItem({ code: "ROB", name: "Robusta" });
  assert.throws(() => S.receive({ godownId: g1.id, itemId: other.id, lotId: S.state.lots[0].id, kg: 1 }), /different item/);
});

test("transfer moves stock and cannot overdraw", () => {
  const { g1, g2, it } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 500, bags: 10 });
  const lot = S.state.lots[0];
  S.transfer({ fromGodownId: g1.id, toGodownId: g2.id, lotId: lot.id, kg: 200, bags: 4 });
  assert.equal(bal(g1.id, lot.id).onHandGrams, 300000);
  assert.equal(bal(g2.id, lot.id).onHandGrams, 200000);
  const ledgerBefore = S.state.ledger.length;
  assert.throws(() => S.transfer({ fromGodownId: g1.id, toGodownId: g2.id, lotId: lot.id, kg: 300.001, bags: 1 }), /Not enough stock/);
  assert.equal(S.state.ledger.length, ledgerBefore, "failed posting must roll back");
  assert.throws(() => S.transfer({ fromGodownId: g1.id, toGodownId: g1.id, lotId: lot.id, kg: 1 }), /different/);
});

test("adjustment needs a known reason and respects stock", () => {
  const { g1, it } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 100, bags: 2 });
  const lot = S.state.lots[0];
  assert.throws(() => S.adjust({ godownId: g1.id, lotId: lot.id, direction: "OUT", kg: 1, reason: "whatever" }), /reason/);
  S.adjust({ godownId: g1.id, lotId: lot.id, direction: "OUT", kg: 1.25, reason: "Moisture / storage weight loss" });
  assert.equal(bal(g1.id, lot.id).onHandGrams, 98750);
  assert.throws(() => S.adjust({ godownId: g1.id, lotId: lot.id, direction: "OUT", kg: 99, reason: "Spillage / bag damage" }), /Not enough/);
});

test("reversing a receipt is blocked once the stock has moved on", () => {
  const { g1, g2, it } = fresh();
  const r = S.receive({ godownId: g1.id, itemId: it.id, kg: 100, bags: 2 });
  const lot = S.state.lots[0];
  S.transfer({ fromGodownId: g1.id, toGodownId: g2.id, lotId: lot.id, kg: 60, bags: 1 });
  assert.throws(() => S.reverseTransaction(r.id, "typo"), /Not enough/);
  assert.equal(S.transaction(r.id).status, "POSTED");
});

test("dispatch draft reserves stock, issues unique barcodes and posts", () => {
  const { g1, it, cl } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 1000, bags: 20 });
  const lot = S.state.lots[0];
  const d = S.saveDispatchDraft({ clientId: cl.id, vehicleNo: "ka 12 ab 3456", lines: [{ godownId: g1.id, lotId: lot.id, kg: 250, bags: 5 }] });
  assert.equal(d.status, "DRAFT");
  assert.equal(d.vehicleNo, "KA 12 AB 3456");
  const pk = S.activePackages(d.id);
  assert.equal(pk.length, 5);
  assert.equal(new Set(pk.map(p => p.barcode)).size, 5);
  pk.forEach(p => assert.equal(S.normaliseBarcode(p.barcode).valid, true));
  assert.equal(pk.reduce((s, p) => s + p.grams, 0), 250000);
  // Reserved, not yet out of on-hand.
  assert.equal(bal(g1.id, lot.id).onHandGrams, 1000000);
  assert.equal(bal(g1.id, lot.id).availableGrams, 750000);
  // Another draft cannot take the reserved stock.
  assert.throws(() => S.saveDispatchDraft({ clientId: cl.id, lines: [{ godownId: g1.id, lotId: lot.id, kg: 800, bags: 1 }] }), /available/);
  S.postDispatch(d.id);
  assert.equal(S.dispatch(d.id).status, "DISPATCHED");
  assert.equal(bal(g1.id, lot.id).onHandGrams, 750000);
  assert.equal(bal(g1.id, lot.id).availableGrams, 750000);
  S.activePackages(d.id).forEach(p => assert.equal(p.status, "DISPATCHED"));
  // Dispatch posting does not burn an extra dispatch number.
  const d2 = S.saveDispatchDraft({ clientId: cl.id, lines: [{ godownId: g1.id, lotId: lot.id, kg: 10, bags: 1 }] });
  assert.equal(d2.no, `DSP-${S.today().slice(0, 4)}-00002`);
});

test("editing draft lines retires old barcodes and never reuses them", () => {
  const { g1, it, cl } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 1000, bags: 20 });
  const lot = S.state.lots[0];
  const d = S.saveDispatchDraft({ clientId: cl.id, lines: [{ godownId: g1.id, lotId: lot.id, kg: 100, bags: 2 }] });
  const old = S.activePackages(d.id).map(p => p.barcode);
  S.saveDispatchDraft({ id: d.id, clientId: cl.id, lines: [{ godownId: g1.id, lotId: lot.id, kg: 150, bags: 3 }] });
  const now = S.activePackages(d.id).map(p => p.barcode);
  assert.equal(now.length, 3);
  assert.ok(old.every(b => !now.includes(b)));
  assert.ok(old.every(b => S.trace(b).found && S.trace(b).package.status === "CANCELLED"));
  // Header-only edit keeps the same barcodes (labels already printed stay valid).
  S.saveDispatchDraft({ id: d.id, clientId: cl.id, vehicleNo: "TN01", lines: [{ godownId: g1.id, lotId: lot.id, kg: 150, bags: 3 }] });
  assert.deepEqual(S.activePackages(d.id).map(p => p.barcode), now);
});

test("package weights must reconcile exactly before posting", () => {
  const { g1, it, cl } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 1000, bags: 20 });
  const lot = S.state.lots[0];
  const d = S.saveDispatchDraft({ clientId: cl.id, lines: [{ godownId: g1.id, lotId: lot.id, kg: 100, bags: 2 }] });
  const [a, b] = S.activePackages(d.id);
  S.setPackageWeights(d.id, { [a.id]: 49.5 });
  assert.throws(() => S.postDispatch(d.id), /do not add up/);
  S.setPackageWeights(d.id, { [b.id]: 50.5 });
  S.postDispatch(d.id);
  assert.equal(S.dispatch(d.id).status, "DISPATCHED");
});

test("reversing a dispatch restores stock and retires its barcodes", () => {
  const { g1, it, cl } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 100, bags: 2 });
  const lot = S.state.lots[0];
  const d = S.saveDispatchDraft({ clientId: cl.id, lines: [{ godownId: g1.id, lotId: lot.id, kg: 100, bags: 2 }] });
  S.postDispatch(d.id);
  assert.equal(bal(g1.id, lot.id).onHandGrams, 0);
  assert.throws(() => S.reverseDispatch(d.id, ""), /reason/);
  S.reverseDispatch(d.id, "Truck did not leave");
  assert.equal(bal(g1.id, lot.id).onHandGrams, 100000);
  assert.equal(S.dispatch(d.id).status, "REVERSED");
  const code = S.state.packages[0].barcode;
  const t = S.trace(code);
  assert.equal(t.found, true);
  assert.equal(t.package.status, "CANCELLED");
});

test("trace resolves a barcode to dispatch, client, lot and godown", () => {
  const { g1, it, cl } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 100, bags: 2, moisturePct: 10.5 });
  const lot = S.state.lots[0];
  const d = S.saveDispatchDraft({ clientId: cl.id, lines: [{ godownId: g1.id, lotId: lot.id, kg: 100, bags: 2 }] });
  S.postDispatch(d.id);
  const p = S.activePackages(d.id)[1];
  const t = S.trace(" " + p.barcode.toLowerCase() + " ");
  assert.equal(t.found, true);
  assert.equal(t.client.name, "Curing Works");
  assert.equal(t.lot.code, lot.code);
  assert.equal(t.godown.code, "G1");
  assert.equal(t.packageNo, `${d.no}-002`);
  assert.equal(t.receipts.length, 1);
  // A single mistyped character is rejected by the check character.
  const bad = p.barcode.slice(0, 6) + (p.barcode[6] === "A" ? "B" : "A") + p.barcode.slice(7);
  const r = S.trace(bad);
  assert.equal(r.found, false);
  assert.equal(r.validFormat, false);
});

test("state survives a reload", () => {
  const { g1, it, reload } = fresh();
  S.receive({ godownId: g1.id, itemId: it.id, kg: 42, bags: 1 });
  reload();
  assert.equal(S.balances()[0].onHandGrams, 42000);
});

test("Code 128 output has start, checksum and stop", () => {
  const bits = Code128.modules("PKG-0123456789A");
  // Start B, 15 data symbols, checksum = 17 symbols * 11 modules + 13-module stop.
  assert.equal(bits.length, 17 * 11 + 13);
  assert.ok(bits.startsWith("11010010000"));
  assert.ok(bits.endsWith("1100011101011"));
  assert.throws(() => Code128.modules("é"), /cannot be encoded/);
});
