/**
 * COFFEE STOCK & DISTRIBUTION — DATA STORE (Phase 1)
 *
 * The rules that keep stock trustworthy live here, independent of the screens:
 *   - Every stock movement is a posted transaction that writes signed ledger rows.
 *     Ledger rows are never edited or deleted; mistakes are corrected by a reversal
 *     transaction that writes compensating rows.
 *   - Balances (on hand / reserved / available) are always computed from the ledger
 *     and open dispatch drafts, so they can never drift from the history.
 *   - Quantities are stored as whole grams (integers) to avoid decimal rounding drift;
 *     screens show kg. Bag counts are tracked alongside as a second quantity.
 *   - Every dispatch package gets a unique, never-reused barcode when it is created,
 *     so labels can be printed and stuck on bags before the truck is loaded.
 *
 * EXTENDING LATER (sourcing, cultivation, fermentation, processing)
 *   Lots carry `sourceType` + `sourceRef`. Today every lot comes from a godown RECEIPT.
 *   A later phase adds its own records (harvest intake, fermentation batch, processing run)
 *   and creates lots with sourceType HARVEST / PROCESSING pointing at them; processing
 *   becomes a new transaction type that consumes input lots and creates output lots.
 *   Nothing in the ledger, dispatch or barcode model has to change for that.
 *
 * CHANGING FIELDS
 *   Add a field     -> add it where the record is created; old records simply lack it
 *                      (screens must treat it as optional). No version bump needed.
 *   Rename/reshape  -> bump SCHEMA_VERSION and add a MIGRATIONS entry.
 *
 * Persistence is a pluggable key/value backend (browser localStorage by default), so the
 * same rules can be unit-tested in Node and later moved behind the shared database.
 */
const EstateStore = (() => {
  const STORAGE_KEY = "estate:coffeeStock";
  const SCHEMA_VERSION = 1;

  // Transaction type -> document number prefix. New process steps (e.g. PROCESSING) add a row here.
  const TXN_PREFIX = { OPENING: "OPN", RECEIPT: "RCV", TRANSFER: "TRF", ADJUSTMENT: "ADJ", DISPATCH: "DSP", REVERSAL: "REV" };
  const TXN_TYPES = Object.keys(TXN_PREFIX);
  const COFFEE_TYPES = ["Arabica", "Robusta"];
  const COFFEE_FORMS = ["Parchment", "Cherry", "Clean / Green", "Other"];
  const ADJUSTMENT_REASONS = [
    "Moisture / storage weight loss",
    "Sampling / quality draw",
    "Spillage / bag damage",
    "Pest / mould write-off",
    "Physical count correction",
    "Other"
  ];
  // Crockford Base32: no I, L, O, U, so hand-keyed codes are not misread.
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  const MIGRATIONS = {
    // 2: state => { ...; return state; }
  };

  let backend = defaultBackend();
  let state = null;
  const listeners = [];

  function defaultBackend() {
    return {
      read() { try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; } },
      write(text) { localStorage.setItem(STORAGE_KEY, text); }
    };
  }

  /* ---------- helpers ---------- */

  function uid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function randomB32(n) {
    const bytes = new Uint8Array(n);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => B32[b & 31]).join("");
  }

  // Mod-37 check character over the Base32 payload, so a mistyped code is rejected
  // instead of resolving to a different package.
  function checkChar(payload) {
    let sum = 0;
    for (const ch of payload) sum = (sum * 32 + B32.indexOf(ch)) % 37;
    return "0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U"[sum];
  }

  function newBarcodeValue() {
    for (;;) {
      const payload = randomB32(10);
      const check = checkChar(payload);
      if (!/[A-Z0-9]/.test(check)) continue; // keep the code to letters/digits only
      const value = `PKG-${payload}${check}`;
      if (!state.packages.some(p => p.barcode === value)) return value;
    }
  }

  // Normalises scanner/keyboard input and verifies the check character.
  function normaliseBarcode(input) {
    const raw = String(input || "").trim().toUpperCase().replace(/\s+/g, "");
    const m = raw.match(/^(?:PKG-?)?([0-9A-Z]{10})([0-9A-Z])$/);
    if (!m) return { value: raw, valid: false };
    const payload = m[1].replace(/O/g, "0").replace(/[IL]/g, "1");
    return { value: `PKG-${payload}${m[2]}`, valid: checkChar(payload) === m[2] };
  }

  const toGrams = kg => Math.round(Number(kg) * 1000);
  const toKg = g => Math.round(g) / 1000;
  const nowIso = () => new Date().toISOString();
  const today = () => new Date().toISOString().slice(0, 10);
  const year = date => String(date || today()).slice(0, 4);

  function fail(message) { const e = new Error(message); e.userFacing = true; throw e; }

  function nextNo(prefix, date) {
    const key = `${prefix}-${year(date)}`;
    state.seq[key] = (state.seq[key] || 0) + 1;
    return `${key}-${String(state.seq[key]).padStart(5, "0")}`;
  }

  function audit(action, entity, entityId, summary) {
    state.events.push({ id: uid(), at: nowIso(), user: state.settings.currentUser || "", action, entity, entityId, summary });
  }

  function emptyState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: { organisation: "Estate Coffee", currentUser: "", labelWidthMm: 100, labelHeightMm: 75 },
      seq: {},
      godowns: [],
      items: [],
      clients: [],
      lots: [],
      transactions: [],
      ledger: [],
      dispatches: [],
      packages: [],
      events: []
    };
  }

  /* ---------- load / save ---------- */

  function load() {
    let parsed = null;
    const text = backend.read();
    if (text) {
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    }
    state = parsed ? migrate(parsed) : emptyState();
    const blank = emptyState();
    for (const k of Object.keys(blank)) if (state[k] === undefined) state[k] = blank[k];
    state.settings = { ...blank.settings, ...state.settings };
    return state;
  }

  function migrate(s) {
    let v = s.schemaVersion || 1;
    if (v > SCHEMA_VERSION) fail("This data was saved by a newer version of the app. Please reload the page.");
    while (v < SCHEMA_VERSION) { v++; if (MIGRATIONS[v]) s = MIGRATIONS[v](s); s.schemaVersion = v; }
    return s;
  }

  function save() {
    backend.write(JSON.stringify(state));
    listeners.forEach(fn => fn());
  }

  // Runs a change against a copy; only commits (and saves) if it finishes without error.
  // This gives every operation all-or-nothing behaviour, like a database transaction.
  function mutate(fn) {
    const snapshot = JSON.stringify(state);
    try {
      const result = fn();
      save();
      return result;
    } catch (e) {
      state = JSON.parse(snapshot);
      throw e;
    }
  }

  /* ---------- lookups ---------- */

  const byId = (list, id) => state[list].find(r => r.id === id) || null;
  const godown = id => byId("godowns", id);
  const item = id => byId("items", id);
  const client = id => byId("clients", id);
  const lot = id => byId("lots", id);
  const dispatch = id => byId("dispatches", id);
  const transaction = id => byId("transactions", id);

  /* ---------- masters ---------- */

  function requireText(v, label) {
    const t = String(v || "").trim();
    if (!t) fail(`${label} is required.`);
    return t;
  }

  function uniqueCode(list, code, exceptId, label) {
    const c = code.toUpperCase();
    if (state[list].some(r => r.code.toUpperCase() === c && r.id !== exceptId)) fail(`${label} code "${code}" is already used.`);
  }

  function saveGodown(data) {
    return mutate(() => {
      const code = requireText(data.code, "Godown code");
      const name = requireText(data.name, "Godown name");
      uniqueCode("godowns", code, data.id, "Godown");
      return upsert("godowns", data.id, { code, name, address: (data.address || "").trim(), active: data.active !== false });
    });
  }

  function saveItem(data) {
    return mutate(() => {
      const code = requireText(data.code, "Item code");
      const name = requireText(data.name, "Item name");
      uniqueCode("items", code, data.id, "Item");
      return upsert("items", data.id, {
        code, name,
        coffeeType: data.coffeeType || "",
        form: data.form || "",
        grade: (data.grade || "").trim(),
        bagKg: data.bagKg ? Number(data.bagKg) : null,
        active: data.active !== false
      });
    });
  }

  function saveClient(data) {
    return mutate(() => {
      const code = requireText(data.code, "Client code");
      const name = requireText(data.name, "Client name");
      uniqueCode("clients", code, data.id, "Client");
      return upsert("clients", data.id, {
        code, name,
        contactPerson: (data.contactPerson || "").trim(),
        phone: (data.phone || "").trim(),
        address: (data.address || "").trim(),
        gstin: (data.gstin || "").trim().toUpperCase(),
        active: data.active !== false
      });
    });
  }

  function upsert(list, id, fields) {
    const existing = id ? byId(list, id) : null;
    if (existing) {
      Object.assign(existing, fields, { updatedAt: nowIso() });
      audit("UPDATE", list, existing.id, fields.code);
      return existing;
    }
    const rec = { id: uid(), ...fields, createdAt: nowIso() };
    state[list].push(rec);
    audit("CREATE", list, rec.id, fields.code);
    return rec;
  }

  /* ---------- balances ---------- */

  // Map key "godownId|lotId" -> { grams, bags } from the ledger.
  function onHandMap() {
    const m = new Map();
    for (const e of state.ledger) {
      const k = `${e.godownId}|${e.lotId}`;
      const b = m.get(k) || { grams: 0, bags: 0 };
      b.grams += e.grams; b.bags += e.bags;
      m.set(k, b);
    }
    return m;
  }

  // Quantities held by draft dispatches (not yet posted), optionally ignoring one dispatch.
  function reservedMap(exceptDispatchId) {
    const m = new Map();
    for (const d of state.dispatches) {
      if (d.status !== "DRAFT" || d.id === exceptDispatchId) continue;
      for (const l of d.lines) {
        const k = `${l.godownId}|${l.lotId}`;
        const b = m.get(k) || { grams: 0, bags: 0 };
        b.grams += l.grams; b.bags += l.bags;
        m.set(k, b);
      }
    }
    return m;
  }

  // One row per godown + lot with any stock or reservation.
  function balances({ includeZero = false } = {}) {
    const onHand = onHandMap();
    const reserved = reservedMap();
    const keys = new Set([...onHand.keys(), ...reserved.keys()]);
    const rows = [];
    for (const k of keys) {
      const [godownId, lotId] = k.split("|");
      const h = onHand.get(k) || { grams: 0, bags: 0 };
      const r = reserved.get(k) || { grams: 0, bags: 0 };
      if (!includeZero && h.grams === 0 && h.bags === 0 && r.grams === 0) continue;
      const l = lot(lotId);
      rows.push({
        godownId, lotId, itemId: l ? l.itemId : null,
        onHandGrams: h.grams, onHandBags: h.bags,
        reservedGrams: r.grams, reservedBags: r.bags,
        availableGrams: h.grams - r.grams, availableBags: h.bags - r.bags
      });
    }
    return rows;
  }

  function available(godownId, lotId, exceptDispatchId) {
    const k = `${godownId}|${lotId}`;
    const h = onHandMap().get(k) || { grams: 0, bags: 0 };
    const r = reservedMap(exceptDispatchId).get(k) || { grams: 0, bags: 0 };
    return { grams: h.grams - r.grams, bags: h.bags - r.bags };
  }

  /* ---------- posting ---------- */

  function cleanQty(kg, bags, { allowZeroBags = true } = {}) {
    const grams = toGrams(kg);
    const b = Number(bags || 0);
    if (!Number.isFinite(grams) || grams <= 0) fail("Quantity (kg) must be greater than zero.");
    if (!Number.isInteger(b) || b < 0) fail("Bags must be a whole number, zero or more.");
    if (!allowZeroBags && b === 0) fail("Bags must be at least 1.");
    return { grams, bags: b };
  }

  function requireActive(rec, label) {
    if (!rec) fail(`${label} not found.`);
    if (rec.active === false) fail(`${label} "${rec.code}" is inactive.`);
    return rec;
  }

  // Writes a posted transaction and its ledger rows, then checks no balance went negative.
  // Must be called inside mutate() so a failed check rolls everything back.
  function post(type, header, entries) {
    if (!TXN_TYPES.includes(type)) fail(`Unknown transaction type ${type}.`);
    const date = header.date || today();
    const txn = {
      id: uid(),
      no: header.no || nextNo(TXN_PREFIX[type], date),
      type,
      status: "POSTED",
      date,
      postedAt: nowIso(),
      postedBy: state.settings.currentUser || "",
      reference: header.reference || "",
      notes: header.notes || "",
      reason: header.reason || "",
      reversesId: header.reversesId || null,
      dispatchId: header.dispatchId || null
    };
    state.transactions.push(txn);
    const touched = new Set();
    for (const e of entries) {
      state.ledger.push({
        id: uid(), txnId: txn.id, date, at: txn.postedAt,
        godownId: e.godownId, lotId: e.lotId, itemId: lot(e.lotId).itemId,
        grams: e.grams, bags: e.bags
      });
      touched.add(`${e.godownId}|${e.lotId}`);
    }
    const onHand = onHandMap();
    const reserved = reservedMap(header.dispatchId);
    for (const k of touched) {
      const h = onHand.get(k) || { grams: 0, bags: 0 };
      const r = reserved.get(k) || { grams: 0, bags: 0 };
      if (h.grams < 0 || h.bags < 0 || h.grams - r.grams < 0) {
        const [gid, lid] = k.split("|");
        fail(`Not enough stock of lot ${lot(lid).code} in ${godown(gid).name}. ` +
          `On hand ${toKg(h.grams + 0)} kg / ${h.bags} bags after this posting` +
          (r.grams ? `, ${toKg(r.grams)} kg held by draft dispatches.` : "."));
      }
    }
    audit("POST", "transactions", txn.id, `${txn.no} ${type}`);
    return txn;
  }

  function resolveLot(data, itemId, date) {
    if (data.lotId) {
      const l = lot(data.lotId);
      if (!l) fail("Lot not found.");
      if (l.itemId !== itemId) fail(`Lot ${l.code} belongs to a different item.`);
      return l;
    }
    const code = (data.lotCode || "").trim().toUpperCase() || nextNo("LOT", date);
    if (state.lots.some(l => l.code === code)) fail(`Lot code ${code} already exists. Pick it from the list instead.`);
    const l = {
      id: uid(), code, itemId,
      sourceType: "RECEIPT",               // later: HARVEST, PROCESSING, PURCHASE ...
      sourceRef: (data.sourceRef || "").trim(),
      moisturePct: data.moisturePct === "" || data.moisturePct == null ? null : Number(data.moisturePct),
      outturnPct: data.outturnPct === "" || data.outturnPct == null ? null : Number(data.outturnPct),
      cropYear: (data.cropYear || "").trim(),
      notes: (data.lotNotes || "").trim(),
      createdAt: nowIso()
    };
    state.lots.push(l);
    audit("CREATE", "lots", l.id, code);
    return l;
  }

  // Stock coming into a godown (or opening balance at go-live).
  function receive(data) {
    return mutate(() => {
      const g = requireActive(godown(data.godownId), "Godown");
      const it = requireActive(item(data.itemId), "Item");
      const q = cleanQty(data.kg, data.bags);
      const date = data.date || today();
      const l = resolveLot(data, it.id, date);
      return post(data.opening ? "OPENING" : "RECEIPT",
        { date, reference: data.reference, notes: data.notes },
        [{ godownId: g.id, lotId: l.id, ...q }]);
    });
  }

  function transfer(data) {
    return mutate(() => {
      const from = requireActive(godown(data.fromGodownId), "From godown");
      const to = requireActive(godown(data.toGodownId), "To godown");
      if (from.id === to.id) fail("From and To godown must be different.");
      const l = lot(data.lotId);
      if (!l) fail("Lot is required.");
      const q = cleanQty(data.kg, data.bags);
      return post("TRANSFER", { date: data.date, reference: data.reference, notes: data.notes }, [
        { godownId: from.id, lotId: l.id, grams: -q.grams, bags: -q.bags },
        { godownId: to.id, lotId: l.id, grams: q.grams, bags: q.bags }
      ]);
    });
  }

  function adjust(data) {
    return mutate(() => {
      const g = requireActive(godown(data.godownId), "Godown");
      const l = lot(data.lotId);
      if (!l) fail("Lot is required.");
      if (!ADJUSTMENT_REASONS.includes(data.reason)) fail("Pick an adjustment reason.");
      if (data.reason === "Other" && !String(data.notes || "").trim()) fail("Notes are required when the reason is Other.");
      const grams = toGrams(data.kg || 0);
      const bags = Number(data.bags || 0);
      if (!Number.isFinite(grams) || !Number.isInteger(bags)) fail("Enter valid quantities.");
      if (grams === 0 && bags === 0) fail("Enter a kg or bag change.");
      const sign = data.direction === "IN" ? 1 : -1;
      return post("ADJUSTMENT", { date: data.date, reference: data.reference, notes: data.notes, reason: data.reason }, [
        { godownId: g.id, lotId: l.id, grams: sign * Math.abs(grams), bags: sign * Math.abs(bags) }
      ]);
    });
  }

  // Undo a posted receipt / transfer / adjustment by writing the opposite ledger rows.
  // Dispatches are reversed through reverseDispatch so their packages are retired too.
  function reverseTransaction(txnId, reason) {
    return mutate(() => reverseInternal(txnId, reason));
  }

  function reverseInternal(txnId, reason) {
    const t = transaction(txnId);
    if (!t) fail("Transaction not found.");
    if (t.status !== "POSTED") fail(`${t.no} is ${t.status.toLowerCase()} and cannot be reversed.`);
    if (t.type === "REVERSAL") fail("A reversal cannot itself be reversed. Post a new transaction instead.");
    if (!String(reason || "").trim()) fail("A reason is required to reverse a transaction.");
    const entries = state.ledger.filter(e => e.txnId === t.id)
      .map(e => ({ godownId: e.godownId, lotId: e.lotId, grams: -e.grams, bags: -e.bags }));
    const rev = post("REVERSAL", { date: today(), reference: t.no, reason: reason.trim(), reversesId: t.id, dispatchId: t.dispatchId }, entries);
    t.status = "REVERSED";
    t.reversedById = rev.id;
    return rev;
  }

  /* ---------- dispatch ---------- */

  // Validates and normalises dispatch lines: [{godownId, lotId, kg, bags, packages}]
  function cleanLines(lines) {
    if (!Array.isArray(lines) || !lines.length) fail("Add at least one dispatch line.");
    return lines.map((l, i) => {
      const g = requireActive(godown(l.godownId), `Line ${i + 1}: godown`);
      const lt = lot(l.lotId);
      if (!lt) fail(`Line ${i + 1}: pick a lot.`);
      const q = cleanQty(l.kg, l.bags);
      const packages = Number(l.packages || q.bags);
      if (!Number.isInteger(packages) || packages < 1) fail(`Line ${i + 1}: number of packages must be at least 1.`);
      if (packages > 2000) fail(`Line ${i + 1}: more than 2000 packages on one line.`);
      return { id: l.id || uid(), godownId: g.id, lotId: lt.id, itemId: lt.itemId, grams: q.grams, bags: q.bags, packages };
    });
  }

  // Splits a line into packages: weight divided evenly (last package takes the remainder),
  // bags spread as evenly as possible.
  function buildPackages(d, line, startSeq) {
    const pk = [];
    const baseG = Math.floor(line.grams / line.packages);
    const baseB = Math.floor(line.bags / line.packages);
    for (let i = 0; i < line.packages; i++) {
      const last = i === line.packages - 1;
      pk.push({
        id: uid(),
        dispatchId: d.id,
        lineId: line.id,
        lotId: line.lotId,
        seq: startSeq + i,
        grams: last ? line.grams - baseG * (line.packages - 1) : baseG,
        bags: baseB + (i < line.bags - baseB * line.packages ? 1 : 0),
        barcode: newBarcodeValue(),
        status: "PREPARED",
        printCount: 0,
        createdAt: nowIso()
      });
    }
    return pk;
  }

  function activePackages(dispatchId) {
    return state.packages.filter(p => p.dispatchId === dispatchId && p.status !== "CANCELLED")
      .sort((a, b) => a.seq - b.seq);
  }

  function checkLinesAvailable(lines, exceptDispatchId) {
    const need = new Map();
    for (const l of lines) {
      const k = `${l.godownId}|${l.lotId}`;
      const n = need.get(k) || { grams: 0, bags: 0 };
      n.grams += l.grams; n.bags += l.bags;
      need.set(k, n);
    }
    for (const [k, n] of need) {
      const [gid, lid] = k.split("|");
      const a = available(gid, lid, exceptDispatchId);
      if (n.grams > a.grams) fail(`Lot ${lot(lid).code} in ${godown(gid).name}: ${toKg(a.grams)} kg available, ${toKg(n.grams)} kg requested.`);
      if (n.bags > a.bags) fail(`Lot ${lot(lid).code} in ${godown(gid).name}: ${a.bags} bags available, ${n.bags} bags requested.`);
    }
  }

  // Create or update a draft. Saving a draft holds (reserves) the stock and issues
  // package barcodes; if lines change, old package barcodes are retired, never reused.
  function saveDispatchDraft(data) {
    return mutate(() => {
      const c = requireActive(client(data.clientId), "Client");
      const lines = cleanLines(data.lines);
      const existing = data.id ? dispatch(data.id) : null;
      if (existing && existing.status !== "DRAFT") fail("Only draft dispatches can be edited.");
      checkLinesAvailable(lines, existing ? existing.id : null);
      const header = {
        clientId: c.id,
        date: data.date || today(),
        destination: (data.destination || c.address || "").trim(),
        vehicleNo: (data.vehicleNo || "").trim().toUpperCase(),
        driverName: (data.driverName || "").trim(),
        driverPhone: (data.driverPhone || "").trim(),
        transporter: (data.transporter || "").trim(),
        reference: (data.reference || "").trim(),
        notes: (data.notes || "").trim()
      };
      let d;
      if (existing) {
        d = existing;
        const before = JSON.stringify(d.lines.map(l => [l.godownId, l.lotId, l.grams, l.bags, l.packages]));
        const after = JSON.stringify(lines.map(l => [l.godownId, l.lotId, l.grams, l.bags, l.packages]));
        Object.assign(d, header, { updatedAt: nowIso() });
        if (before !== after) {
          for (const p of activePackages(d.id)) { p.status = "CANCELLED"; p.cancelledAt = nowIso(); }
          d.lines = lines;
          let seq = 1;
          for (const l of lines) { const pk = buildPackages(d, l, seq); state.packages.push(...pk); seq += pk.length; }
        }
        audit("UPDATE", "dispatches", d.id, d.no);
      } else {
        d = { id: uid(), no: nextNo("DSP", header.date), status: "DRAFT", ...header, lines, createdAt: nowIso(), createdBy: state.settings.currentUser || "" };
        state.dispatches.push(d);
        let seq = 1;
        for (const l of lines) { const pk = buildPackages(d, l, seq); state.packages.push(...pk); seq += pk.length; }
        audit("CREATE", "dispatches", d.id, d.no);
      }
      return d;
    });
  }

  // Package weights can be corrected (e.g. after weighing each bag) while the dispatch is a draft.
  function setPackageWeights(dispatchId, weights) {
    return mutate(() => {
      const d = dispatch(dispatchId);
      if (!d || d.status !== "DRAFT") fail("Package weights can only be changed on a draft dispatch.");
      for (const [pkgId, kg] of Object.entries(weights)) {
        const p = state.packages.find(x => x.id === pkgId && x.dispatchId === d.id && x.status !== "CANCELLED");
        if (!p) fail("Package not found on this dispatch.");
        const g = toGrams(kg);
        if (!Number.isFinite(g) || g <= 0) fail(`Package ${packageNo(p)}: weight must be greater than zero.`);
        p.grams = g;
      }
      audit("UPDATE", "packages", d.id, `${d.no} package weights`);
      return d;
    });
  }

  // Line total vs sum of its packages; post is blocked until every line reconciles exactly.
  function reconciliation(d) {
    const pk = activePackages(d.id);
    return d.lines.map(l => {
      const mine = pk.filter(p => p.lineId === l.id);
      const g = mine.reduce((s, p) => s + p.grams, 0);
      const b = mine.reduce((s, p) => s + p.bags, 0);
      return { lineId: l.id, lineGrams: l.grams, packageGrams: g, lineBags: l.bags, packageBags: b, ok: g === l.grams && b === l.bags };
    });
  }

  function postDispatch(dispatchId) {
    return mutate(() => {
      const d = dispatch(dispatchId);
      if (!d) fail("Dispatch not found.");
      if (d.status !== "DRAFT") fail(`${d.no} is already ${d.status.toLowerCase()}.`);
      const bad = reconciliation(d).find(r => !r.ok);
      if (bad) fail("Package weights/bags do not add up to the dispatch line totals. Fix package weights before posting.");
      const entries = d.lines.map(l => ({ godownId: l.godownId, lotId: l.lotId, grams: -l.grams, bags: -l.bags }));
      // The dispatch transaction shares the dispatch number.
      const txn = post("DISPATCH", { no: d.no, date: d.date, reference: client(d.clientId).name, notes: d.notes, dispatchId: d.id }, entries);
      d.status = "DISPATCHED";
      d.txnId = txn.id;
      d.postedAt = txn.postedAt;
      d.postedBy = txn.postedBy;
      for (const p of activePackages(d.id)) { p.status = "DISPATCHED"; p.dispatchedAt = txn.postedAt; }
      audit("POST", "dispatches", d.id, `${d.no} dispatched (${activePackages(d.id).length} packages)`);
      return d;
    });
  }

  function cancelDispatchDraft(dispatchId, reason) {
    return mutate(() => {
      const d = dispatch(dispatchId);
      if (!d || d.status !== "DRAFT") fail("Only draft dispatches can be cancelled.");
      d.status = "CANCELLED";
      d.cancelReason = (reason || "").trim();
      d.cancelledAt = nowIso();
      for (const p of activePackages(d.id)) { p.status = "CANCELLED"; p.cancelledAt = d.cancelledAt; }
      audit("CANCEL", "dispatches", d.id, d.no);
      return d;
    });
  }

  // A posted dispatch entered by mistake (goods never left): stock goes back to the same
  // godown and lot, and its barcodes are retired (they still resolve, showing REVERSED).
  function reverseDispatch(dispatchId, reason) {
    return mutate(() => {
      const d = dispatch(dispatchId);
      if (!d || d.status !== "DISPATCHED") fail("Only dispatched (posted) dispatches can be reversed.");
      const rev = reverseInternal(d.txnId, reason);
      d.status = "REVERSED";
      d.reversedAt = rev.postedAt;
      d.reverseReason = reason.trim();
      const pk = state.packages.filter(p => p.dispatchId === d.id && p.status === "DISPATCHED");
      for (const p of pk) { p.status = "CANCELLED"; p.cancelledAt = rev.postedAt; }
      audit("REVERSE", "dispatches", d.id, `${d.no}: ${reason.trim()}`);
      return d;
    });
  }

  function markPrinted(packageIds) {
    return mutate(() => {
      for (const id of packageIds) {
        const p = state.packages.find(x => x.id === id);
        if (p) p.printCount = (p.printCount || 0) + 1;
      }
      audit("PRINT", "packages", packageIds.length === 1 ? packageIds[0] : "", `${packageIds.length} label(s) printed`);
    });
  }

  function packageNo(p) {
    const d = dispatch(p.dispatchId);
    return `${d ? d.no : "?"}-${String(p.seq).padStart(3, "0")}`;
  }

  // Full trace for a scanned/typed barcode.
  function trace(input) {
    const n = normaliseBarcode(input);
    const p = state.packages.find(x => x.barcode === n.value);
    if (!p) return { found: false, value: n.value, validFormat: n.valid };
    const d = dispatch(p.dispatchId);
    const l = lot(p.lotId);
    const line = d.lines.find(x => x.id === p.lineId);
    return {
      found: true, value: p.barcode,
      package: p, packageNo: packageNo(p),
      packageCount: activePackages(d.id).length || state.packages.filter(x => x.dispatchId === d.id).length,
      dispatch: d, client: client(d.clientId), lot: l, item: item(l.itemId),
      godown: line ? godown(line.godownId) : null,
      receipts: state.transactions.filter(t => (t.type === "RECEIPT" || t.type === "OPENING") &&
        state.ledger.some(e => e.txnId === t.id && e.lotId === l.id)),
      events: state.events.filter(e => e.entityId === d.id || e.entityId === p.id)
    };
  }

  /* ---------- backup ---------- */

  function exportJson() { return JSON.stringify(state, null, 2); }

  function importJson(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { fail("That file is not valid JSON."); }
    if (!parsed || !Array.isArray(parsed.ledger) || !Array.isArray(parsed.lots)) fail("That file is not a coffee stock backup.");
    state = migrate(parsed);
    save();
  }

  function updateSettings(fields) {
    return mutate(() => { Object.assign(state.settings, fields); audit("UPDATE", "settings", "", Object.keys(fields).join(", ")); });
  }

  // Loads a small demo dataset so the screens can be explored. Only allowed on an empty store.
  function loadDemo() {
    if (state.ledger.length || state.dispatches.length) fail("Demo data can only be loaded into an empty store.");
    const g1 = saveGodown({ code: "GD-MAIN", name: "Main Godown", address: "Estate Road" });
    const g2 = saveGodown({ code: "GD-TOWN", name: "Town Godown", address: "Market Yard" });
    const i1 = saveItem({ code: "ARA-PCH-A", name: "Arabica Parchment A", coffeeType: "Arabica", form: "Parchment", grade: "A", bagKg: 50 });
    const i2 = saveItem({ code: "ROB-CHR", name: "Robusta Cherry", coffeeType: "Robusta", form: "Cherry", grade: "AB", bagKg: 50 });
    saveClient({ code: "CL-001", name: "Highland Curing Works", contactPerson: "Purchase Desk", phone: "", address: "Industrial Area" });
    saveClient({ code: "CL-002", name: "Coastal Exports", contactPerson: "", phone: "", address: "Port Road" });
    receive({ opening: true, godownId: g1.id, itemId: i1.id, kg: 5000, bags: 100, moisturePct: 10.5, cropYear: "2025-26", reference: "Opening stock" });
    receive({ godownId: g1.id, itemId: i2.id, kg: 3000, bags: 60, moisturePct: 11, cropYear: "2025-26", reference: "Estate delivery" });
    receive({ godownId: g2.id, itemId: i2.id, kg: 1500, bags: 30, cropYear: "2025-26", reference: "Estate delivery" });
  }

  function onChange(fn) { listeners.push(fn); }

  function useBackend(b) { backend = b; load(); }

  return {
    // constants
    TXN_TYPES, COFFEE_TYPES, COFFEE_FORMS, ADJUSTMENT_REASONS,
    // lifecycle
    load, onChange, useBackend, get state() { return state; },
    // lookups
    godown, item, client, lot, dispatch, transaction, activePackages, packageNo,
    // masters
    saveGodown, saveItem, saveClient,
    // stock
    balances, available, receive, transfer, adjust, reverseTransaction,
    // dispatch
    saveDispatchDraft, setPackageWeights, reconciliation, postDispatch, cancelDispatchDraft, reverseDispatch, markPrinted,
    // barcode
    normaliseBarcode, trace,
    // misc
    exportJson, importJson, updateSettings, loadDemo,
    toKg, toGrams, today
  };
})();

if (typeof module !== "undefined") module.exports = EstateStore;
