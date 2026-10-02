/**
 * ONEUPTECH ESTATE — SCREENS
 *
 * Hash-routed single page. Every view is async: it fetches what it needs from the
 * API (/api/v1), returns HTML, and wires its handlers. All business rules live in the
 * Worker and the database; this file collects input, shows results and prints labels
 * and dispatch notes. Small reference lists (godowns, items, clients, org, me) are
 * cached in M and refreshed after edits.
 */
(() => {
  const view = document.getElementById("view");
  const printRoot = document.getElementById("printRoot");

  const M = { me: null, org: null, godowns: [], items: [], clients: [] };
  const ROLE_LABEL = { admin: "Administrator", manager: "Manager", operator: "Godown operator", viewer: "Viewer" };

  /* ---------- permissions (the API enforces the same; this only hides what you can't do) ---------- */

  const can = {
    post: () => ["admin", "manager", "operator"].includes(M.me.role),
    manage: () => ["admin", "manager"].includes(M.me.role),
    admin: () => M.me.role === "admin"
  };
  // Godowns this user may post in (operators: assigned ones only).
  const postGodowns = () => active(M.godowns).filter(g => M.me.role !== "operator" || M.me.godownIds.includes(g.id));

  /* ---------- formatting ---------- */

  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const kg = g => (Number(g) / 1000).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  const num = n => Number(n || 0).toLocaleString("en-IN");
  const toGrams = v => Math.round(Number(v) * 1000);
  const today = () => new Date().toISOString().slice(0, 10);
  const fmtDate = d => d ? new Date(d.length === 10 ? d + "T00:00:00" : d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "";
  const fmtTime = d => d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const itemMeta = it => it ? [it.coffeeType, it.form, it.grade && `Grade ${it.grade}`].filter(Boolean).join(" · ") : "";
  const byId = (list, id) => list.find(r => r.id === id) || null;
  const godownName = id => (byId(M.godowns, id) || { name: "?" }).name;
  const item = id => byId(M.items, id) || { name: "?", id };
  const active = list => list.filter(r => r.active !== false);

  const STATUS_CLASS = { DRAFT: "amber", DISPATCHED: "green", POSTED: "green", PREPARED: "amber", CANCELLED: "grey", REVERSED: "red", INACTIVE: "grey", ACTIVE: "green" };
  const badge = s => `<span class="badge ${STATUS_CLASS[s] || "grey"}">${esc(s)}</span>`;

  function toast(msg, kind = "ok") {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className = `toast show ${kind}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = "toast"; }, kind === "error" ? 6000 : 3000);
  }

  // Runs an API action with the button disabled; shows the server's message on failure.
  async function attempt(fn, okMsg, button) {
    if (button) button.disabled = true;
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.userFacing ? e.message : `Unexpected error: ${e.message}`, "error");
      if (!e.userFacing) console.error(e);
      return undefined;
    } finally {
      if (button) button.disabled = false;
    }
  }

  const formData = form => Object.fromEntries(new FormData(form).entries());
  const options = (list, selected, labelFn, placeholder) =>
    (placeholder ? `<option value="">${esc(placeholder)}</option>` : "") +
    list.map(r => `<option value="${esc(r.id)}" ${r.id === selected ? "selected" : ""}>${esc(labelFn(r))}</option>`).join("");
  const plainOptions = (list, selected, placeholder) =>
    (placeholder ? `<option value="">${esc(placeholder)}</option>` : "") +
    list.map(v => `<option ${v === selected ? "selected" : ""}>${esc(v)}</option>`).join("");

  function setupNeeded() {
    const missing = [];
    if (!active(M.godowns).length) missing.push(`<a href="#/masters/godowns">a godown</a>`);
    if (!active(M.items).length) missing.push(`<a href="#/masters/items">a coffee item</a>`);
    if (missing.length) return `<div class="notice">Add ${missing.join(" and ")} first.</div>`;
    if (M.me.role === "operator" && !postGodowns().length) return `<div class="notice">You are not assigned to any godown yet. Ask an administrator to assign you.</div>`;
    return "";
  }

  const lotOption = (b, selected) =>
    `<option value="${esc(b.lotId)}" data-item="${esc(b.itemId)}" ${b.lotId === selected ? "selected" : ""}>${esc(b.lotCode)} — ${esc(item(b.itemId).name)} (${kg(b.availableGrams)} kg, ${num(b.availableBags)} bags free)</option>`;

  const query = () => new URLSearchParams(location.hash.split("?")[1] || "");

  /* ---------- reference data ---------- */

  async function loadMasters() {
    const [g, i, c, org] = await Promise.all([Api.get("/godowns"), Api.get("/items"), Api.get("/clients"), Api.get("/org")]);
    M.godowns = g.godowns; M.items = i.items; M.clients = c.clients; M.org = org;
    document.getElementById("orgName").textContent = org.name;
  }

  /* ---------- routes ---------- */

  const routes = [
    [/^\/?$/, dashboard, "dashboard"],
    [/^\/stock$/, stockView, "stock"],
    [/^\/lot\/([^/?]+)$/, lotView, "stock"],
    [/^\/receive$/, receiveView, "receive"],
    [/^\/transfer$/, transferView, "transfer"],
    [/^\/adjust$/, adjustView, "adjust"],
    [/^\/ledger$/, ledgerView, "ledger"],
    [/^\/dispatches$/, dispatchList, "dispatches"],
    [/^\/dispatch\/new$/, () => dispatchForm(null), "dispatch-new"],
    [/^\/dispatch\/([^/?]+)\/edit$/, id => dispatchForm(id), "dispatches"],
    [/^\/dispatch\/([^/?]+)$/, dispatchDetail, "dispatches"],
    [/^\/track(?:\/([^?]+))?$/, trackView, "track"],
    [/^\/masters\/(godowns|items|clients)(?:\/([^/?]+))?$/, mastersView, "masters"],
    [/^\/users(?:\/([^/?]+))?$/, usersView, "users"],
    [/^\/settings$/, settingsView, "settings"]
  ];

  let renderSeq = 0;
  let after = null;
  // Views register wiring that must run once their HTML is in the page.
  const then = fn => { after = fn; };

  async function render() {
    const seq = ++renderSeq;
    const path = decodeURIComponent(location.hash.replace(/^#/, "").split("?")[0]) || "/";
    for (const [re, fn, nav] of routes) {
      const m = path.match(re);
      if (!m) continue;
      document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === nav));
      view.classList.add("loading");
      after = null;
      let html;
      let wire = null;
      try {
        html = await fn(...m.slice(1));
        wire = after;
      } catch (e) {
        if (seq !== renderSeq) return;
        html = `<div class="empty">${esc(e.userFacing ? e.message : "Something went wrong loading this page.")} <a href="#/">Go to dashboard</a></div>`;
        if (!e.userFacing) console.error(e);
      }
      after = null;
      if (seq !== renderSeq) return; // the user has already moved on
      view.classList.remove("loading");
      view.innerHTML = html || "";
      if (wire) wire();
      return;
    }
    view.innerHTML = `<div class="empty">Page not found. <a href="#/">Go to dashboard</a></div>`;
  }

  window.addEventListener("hashchange", () => {
    if (!M.me) return;
    render();
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    document.getElementById("sidenav").classList.remove("open");
  });

  /* ---------- dashboard ---------- */

  async function dashboard() {
    const [d, tx] = await Promise.all([Api.get("/dashboard"), Api.get("/transactions?limit=8")]);
    const empty = !M.godowns.length && !M.items.length;
    return `
      <div class="page-head">
        <div><h1>Dashboard</h1><p class="sub">Coffee held in godowns and dispatched to clients.</p></div>
        ${can.post() ? `<div class="actions"><a class="btn" href="#/receive">+ Receive stock</a><a class="btn primary" href="#/dispatch/new">+ New dispatch</a></div>` : ""}
      </div>
      ${empty ? `<div class="notice">Nothing set up yet. ${can.manage() ? `Add your <a href="#/masters/godowns">godowns</a>, <a href="#/masters/items">coffee items</a> and <a href="#/masters/clients">clients</a> to begin.` : "Ask a manager to add godowns, coffee items and clients."}</div>` : ""}
      <div class="tiles">
        <div class="tile"><div class="tile-label">Stock on hand</div><div class="tile-value">${kg(d.onHandGrams)} <small>kg</small></div><div class="tile-foot">${num(d.onHandBags)} bags</div></div>
        <div class="tile"><div class="tile-label">Held by draft dispatches</div><div class="tile-value">${kg(d.reservedGrams)} <small>kg</small></div><div class="tile-foot">${d.draftCount} draft${d.draftCount === 1 ? "" : "s"}</div></div>
        <div class="tile"><div class="tile-label">Dispatched this month</div><div class="tile-value">${kg(d.monthDispatchGrams)} <small>kg</small></div><div class="tile-foot">${d.monthDispatchCount} dispatch${d.monthDispatchCount === 1 ? "" : "es"}</div></div>
        <div class="tile"><div class="tile-label">Lots in stock</div><div class="tile-value">${d.lotsInStock}</div><div class="tile-foot">${active(M.godowns).length} godowns</div></div>
      </div>
      <div class="grid-2">
        <section class="card">
          <h2>By godown</h2>
          ${d.byGodown.length ? `<table class="tbl"><thead><tr><th>Godown</th><th class="r">kg</th><th class="r">Bags</th></tr></thead><tbody>
            ${d.byGodown.map(r => `<tr><td><a href="#/stock?g=${esc(r.id)}">${esc(r.name)}</a></td><td class="r mono">${kg(r.grams)}</td><td class="r mono">${num(r.bags)}</td></tr>`).join("")}
          </tbody></table>` : `<div class="empty">No godowns yet.</div>`}
        </section>
        <section class="card">
          <h2>By coffee item</h2>
          ${d.byItem.length ? `<table class="tbl"><thead><tr><th>Item</th><th class="r">kg</th><th class="r">Bags</th></tr></thead><tbody>
            ${d.byItem.map(r => `<tr><td>${esc(r.name)}<div class="muted">${esc(itemMeta(r))}</div></td><td class="r mono">${kg(r.grams)}</td><td class="r mono">${num(r.bags)}</td></tr>`).join("")}
          </tbody></table>` : `<div class="empty">No stock yet.</div>`}
        </section>
      </div>
      ${d.drafts.length ? `<section class="card flush"><h2>Draft dispatches waiting to be posted</h2>${dispatchTable(d.drafts)}</section>` : ""}
      <section class="card flush">
        <h2>Recent activity</h2>
        ${tx.transactions.length ? txnTable(tx.transactions) : `<div class="empty">No stock movements yet.</div>`}
      </section>`;
  }

  /* ---------- stock ---------- */

  async function stockView() {
    const q = query();
    const gSel = q.get("g") || "", iSel = q.get("i") || "";
    const params = new URLSearchParams();
    if (gSel) params.set("location_id", gSel);
    if (iSel) params.set("item_id", iSel);
    const { balances } = await Api.get(`/stock/balances?${params}`);
    const rows = balances.map(b => ({ ...b, g: godownName(b.locationId), it: item(b.itemId) }))
      .sort((a, b) => a.g.localeCompare(b.g) || a.lotCode.localeCompare(b.lotCode));
    const tot = rows.reduce((s, r) => ({ g: s.g + r.onHandGrams, b: s.b + r.onHandBags, rg: s.rg + r.reservedGrams, ag: s.ag + r.availableGrams, ab: s.ab + r.availableBags }), { g: 0, b: 0, rg: 0, ag: 0, ab: 0 });
    then(() => {
      document.getElementById("stockFilter").addEventListener("change", e => {
        const f = formData(e.currentTarget);
        location.hash = `#/stock?g=${encodeURIComponent(f.g)}&i=${encodeURIComponent(f.i)}`;
      });
      document.getElementById("exportStock").addEventListener("click", () => downloadCsv("stock-on-hand.csv",
        [["Godown", "Lot", "Item", "Type", "Form", "Grade", "On hand kg", "On hand bags", "Reserved kg", "Available kg", "Available bags"],
          ...rows.map(r => [r.g, r.lotCode, r.it.name, r.it.coffeeType, r.it.form, r.it.grade, r.onHandGrams / 1000, r.onHandBags, r.reservedGrams / 1000, r.availableGrams / 1000, r.availableBags])]));
    });
    return `
      <div class="page-head">
        <div><h1>Stock on hand</h1><p class="sub">By godown and lot. Available = on hand minus what draft dispatches hold.</p></div>
        <div class="actions"><button class="btn" id="exportStock">Export CSV</button></div>
      </div>
      <form class="filters" id="stockFilter">
        <label>Godown<select name="g">${options(M.godowns, gSel, g => g.name, "All godowns")}</select></label>
        <label>Item<select name="i">${options(M.items, iSel, it => it.name, "All items")}</select></label>
      </form>
      <section class="card flush">
        ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Godown</th><th>Lot</th><th>Item</th><th class="r">On hand kg</th><th class="r">Bags</th><th class="r">Reserved kg</th><th class="r">Available kg</th><th class="r">Avail. bags</th></tr></thead><tbody>
          ${rows.map(r => `<tr><td>${esc(r.g)}</td><td><a class="mono" href="#/lot/${esc(r.lotId)}">${esc(r.lotCode)}</a></td><td>${esc(r.it.name)}<div class="muted">${esc(itemMeta(r.it))}</div></td>
            <td class="r mono">${kg(r.onHandGrams)}</td><td class="r mono">${num(r.onHandBags)}</td><td class="r mono">${r.reservedGrams ? kg(r.reservedGrams) : "–"}</td><td class="r mono strong">${kg(r.availableGrams)}</td><td class="r mono">${num(r.availableBags)}</td></tr>`).join("")}
          </tbody><tfoot><tr><td colspan="3">Total</td><td class="r mono">${kg(tot.g)}</td><td class="r mono">${num(tot.b)}</td><td class="r mono">${kg(tot.rg)}</td><td class="r mono">${kg(tot.ag)}</td><td class="r mono">${num(tot.ab)}</td></tr></tfoot></table></div>`
          : `<div class="empty">No stock matches. ${setupNeeded() || (can.post() ? `<a href="#/receive">Receive stock</a>` : "")}</div>`}
      </section>`;
  }

  async function lotView(lotId) {
    const { lot: l, history, packagesDispatched } = await Api.get(`/lots/${encodeURIComponent(lotId)}`);
    const it = item(l.itemId);
    let runG = 0;
    const rows = history.map(h => { runG += h.grams; return { ...h, runG }; });
    return `
      <div class="page-head"><div><div class="crumb"><a href="#/stock">Stock</a> / Lot</div><h1 class="mono">${esc(l.code)}</h1><p class="sub">${esc(it.name)} · ${esc(itemMeta(it))}</p></div></div>
      <section class="card">
        <dl class="facts">
          <div><dt>Source</dt><dd>${esc(l.sourceType)}${l.sourceRef ? ` · ${esc(l.sourceRef)}` : ""}</dd></div>
          <div><dt>Crop year</dt><dd>${esc(l.cropYear || "–")}</dd></div>
          <div><dt>Moisture at receipt</dt><dd>${l.moisturePct != null ? esc(l.moisturePct) + " %" : "–"}</dd></div>
          <div><dt>Outturn</dt><dd>${l.outturnPct != null ? esc(l.outturnPct) + " %" : "–"}</dd></div>
          <div><dt>Packages dispatched</dt><dd>${packagesDispatched}</dd></div>
          <div><dt>Created</dt><dd>${fmtDate(l.createdAt)}</dd></div>
        </dl>
        ${l.notes ? `<p class="muted">${esc(l.notes)}</p>` : ""}
      </section>
      <section class="card flush"><h2>Movement history</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Txn</th><th>Type</th><th>Godown</th><th class="r">kg</th><th class="r">Bags</th><th class="r">Lot balance kg</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${fmtDate(r.date)}</td><td class="mono">${r.dispatchId ? `<a href="#/dispatch/${esc(r.dispatchId)}">${esc(r.no)}</a>` : esc(r.no)}</td><td>${esc(r.type)}</td><td>${esc(godownName(r.locationId))}</td>
          <td class="r mono ${r.grams < 0 ? "neg" : "pos"}">${r.grams > 0 ? "+" : ""}${kg(r.grams)}</td><td class="r mono">${r.bags > 0 ? "+" : ""}${num(r.bags)}</td><td class="r mono">${kg(r.runG)}</td></tr>`).join("")}
        </tbody></table></div>
      </section>`;
  }

  /* ---------- receive / transfer / adjust ---------- */

  function showPosted(no) {
    const el = document.getElementById("postedNote");
    if (el) el.innerHTML = `<div class="notice ok">Posted <strong class="mono">${esc(no)}</strong>. <a href="#/stock">View stock</a></div>`;
  }

  // Pre-fills kg from bags × the item's standard bag weight, until kg is typed by hand.
  function autoKg(form, bagsInput, kgInput, itemIdFn) {
    form.addEventListener("input", e => {
      if (e.target === kgInput) kgInput.dataset.touched = "1";
      if (e.target !== bagsInput || kgInput.dataset.touched) return;
      const it = byId(M.items, itemIdFn());
      if (it && it.bagGrams) kgInput.value = (Number(bagsInput.value || 0) * it.bagGrams) / 1000 || "";
    });
  }

  async function receiveView() {
    if (!can.post()) return `<div class="empty">Your role cannot post stock.</div>`;
    then(() => {
      const f = document.getElementById("receiveForm");
      let lotsCache = {};
      const sync = async () => {
        const isNew = f.lotMode.value === "new";
        f.querySelectorAll("[data-newlot]").forEach(el => el.hidden = !isNew);
        f.querySelector("[data-oldlot]").hidden = isNew;
        const itemId = f.itemId.value;
        if (isNew || !itemId) { f.lotId.innerHTML = `<option value="">${itemId ? "Select lot" : "Select an item first"}</option>`; return; }
        lotsCache[itemId] = lotsCache[itemId] || (await Api.get(`/lots?item_id=${encodeURIComponent(itemId)}`)).lots;
        f.lotId.innerHTML = options(lotsCache[itemId], "", l => l.code, lotsCache[itemId].length ? "Select lot" : "No lots for this item yet");
      };
      f.addEventListener("change", e => { if (e.target.name === "lotMode" || e.target.name === "itemId") sync(); });
      autoKg(f, f.bags, f.kg, () => f.itemId.value);
      sync();
      f.addEventListener("submit", async e => {
        e.preventDefault();
        const d = formData(f);
        const body = {
          date: d.date, locationId: d.locationId, itemId: d.itemId, grams: toGrams(d.kg), bags: Number(d.bags || 0),
          reference: d.reference, notes: d.notes, opening: d.opening === "on"
        };
        if (d.lotMode === "existing") {
          if (!d.lotId) return toast("Pick the existing lot to add to.", "error");
          body.lotId = d.lotId;
        } else {
          body.lot = {
            code: d.lotCode, cropYear: d.cropYear, sourceRef: d.sourceRef, notes: "",
            moisturePct: d.moisturePct === "" ? null : Number(d.moisturePct), outturnPct: d.outturnPct === "" ? null : Number(d.outturnPct)
          };
        }
        const r = await attempt(() => Api.post("/receipts", body), "Stock received", f.querySelector("[type=submit]"));
        if (r) { f.reset(); delete f.kg.dataset.touched; f.date.value = today(); lotsCache = {}; sync(); showPosted(`${r.no} · lot ${r.lotCode}`); }
      });
    });
    return `
      <div class="page-head"><div><h1>Receive stock</h1><p class="sub">Coffee arriving at a godown. Each receipt adds to a lot — new or existing.</p></div></div>
      ${setupNeeded()}
      <div id="postedNote"></div>
      <form class="card form" id="receiveForm">
        <div class="form-grid">
          <label>Date<input type="date" name="date" value="${today()}" max="${today()}" required></label>
          <label>Godown<select name="locationId" required>${options(postGodowns(), "", g => g.name, "Select godown")}</select></label>
          <label class="span-2">Coffee item<select name="itemId" required>${options(active(M.items), "", it => `${it.name} (${it.code})`, "Select item")}</select></label>
          <fieldset class="span-2 seg"><legend>Lot</legend>
            <label><input type="radio" name="lotMode" value="new" checked> New lot</label>
            <label><input type="radio" name="lotMode" value="existing"> Add to existing lot</label>
          </fieldset>
          <label data-newlot>Lot code<input name="lotCode" placeholder="Auto: LOT-${today().slice(0, 4)}-…" maxlength="40"></label>
          <label data-newlot>Crop year<input name="cropYear" placeholder="e.g. 2025-26" maxlength="20"></label>
          <label data-newlot>Moisture %<input type="number" name="moisturePct" step="0.1" min="0" max="100"></label>
          <label data-newlot>Outturn %<input type="number" name="outturnPct" step="0.1" min="0" max="100"></label>
          <label data-newlot class="span-2">Source / estate reference<input name="sourceRef" placeholder="Estate, block, supplier or delivery reference" maxlength="120"></label>
          <label data-oldlot class="span-2" hidden>Existing lot<select name="lotId"></select></label>
          <label>Bags<input type="number" name="bags" min="0" step="1" required></label>
          <label>Net weight (kg)<input type="number" name="kg" min="0.001" step="0.001" required></label>
          <label class="span-2">Reference (weighbridge slip, delivery note)<input name="reference" maxlength="80"></label>
          <label class="span-2">Notes<textarea name="notes" rows="2" maxlength="300"></textarea></label>
          <label class="check span-2"><input type="checkbox" name="opening"> Opening balance (stock already in the godown at go-live)</label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Post receipt</button></div>
      </form>`;
  }

  // Fills a lot <select> with lots that have stock in the chosen godown.
  async function fillLotPicker(select, godownId, { includeEmpty = false, exceptDispatch = null, keep = "" } = {}) {
    if (!godownId) { select.innerHTML = `<option value="">Select godown first</option>`; return; }
    select.innerHTML = `<option value="">Loading…</option>`;
    const qs = new URLSearchParams({ location_id: godownId });
    if (exceptDispatch) qs.set("except_dispatch", exceptDispatch);
    try {
      const { balances } = await Api.get(`/stock/balances?${qs}`);
      const rows = balances.filter(b => includeEmpty || b.availableGrams > 0 || b.lotId === keep);
      select.innerHTML = `<option value="">${rows.length ? "Select lot" : "No stock in this godown"}</option>` + rows.map(b => lotOption(b, keep)).join("");
    } catch (e) {
      select.innerHTML = `<option value="">Could not load lots</option>`;
    }
  }

  async function transferView() {
    if (!can.post()) return `<div class="empty">Your role cannot post stock.</div>`;
    then(() => {
      const f = document.getElementById("transferForm");
      f.fromLocationId.addEventListener("change", () => fillLotPicker(f.lotId, f.fromLocationId.value));
      fillLotPicker(f.lotId, f.fromLocationId.value);
      f.addEventListener("submit", async e => {
        e.preventDefault();
        const d = formData(f);
        const body = { date: d.date, fromLocationId: d.fromLocationId, toLocationId: d.toLocationId, lotId: d.lotId, grams: toGrams(d.kg), bags: Number(d.bags || 0), reference: d.reference, notes: d.notes };
        const r = await attempt(() => Api.post("/transfers", body), "Transfer posted", f.querySelector("[type=submit]"));
        if (r) { f.reset(); f.date.value = today(); fillLotPicker(f.lotId, f.fromLocationId.value); showPosted(r.no); }
      });
    });
    return `
      <div class="page-head"><div><h1>Transfer between godowns</h1><p class="sub">Moves a lot from one godown to another in a single posting.</p></div></div>
      ${setupNeeded()}
      <div id="postedNote"></div>
      <form class="card form" id="transferForm">
        <div class="form-grid">
          <label>Date<input type="date" name="date" value="${today()}" max="${today()}" required></label>
          <label>Reference<input name="reference" maxlength="80" placeholder="Vehicle / gate pass"></label>
          <label>From godown<select name="fromLocationId" required>${options(postGodowns(), "", g => g.name, "Select")}</select></label>
          <label>To godown<select name="toLocationId" required>${options(active(M.godowns), "", g => g.name, "Select")}</select></label>
          <label class="span-2">Lot<select name="lotId" required></select></label>
          <label>Bags<input type="number" name="bags" min="0" step="1" required></label>
          <label>Net weight (kg)<input type="number" name="kg" min="0.001" step="0.001" required></label>
          <label class="span-2">Notes<textarea name="notes" rows="2" maxlength="300"></textarea></label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Post transfer</button></div>
      </form>`;
  }

  async function adjustView() {
    if (!can.manage()) return `<div class="empty">Adjustments need a manager.</div>`;
    const { reasons } = await Api.get("/reference/adjustment-reasons");
    then(() => {
      const f = document.getElementById("adjustForm");
      f.locationId.addEventListener("change", () => fillLotPicker(f.lotId, f.locationId.value, { includeEmpty: true }));
      fillLotPicker(f.lotId, f.locationId.value, { includeEmpty: true });
      f.addEventListener("submit", async e => {
        e.preventDefault();
        const d = formData(f);
        const body = { date: d.date, locationId: d.locationId, lotId: d.lotId, direction: d.direction, grams: toGrams(d.kg || 0), bags: Number(d.bags || 0), reason: d.reason, reference: d.reference, notes: d.notes };
        const r = await attempt(() => Api.post("/adjustments", body), "Adjustment posted", f.querySelector("[type=submit]"));
        if (r) { f.reset(); f.date.value = today(); fillLotPicker(f.lotId, f.locationId.value, { includeEmpty: true }); showPosted(r.no); }
      });
    });
    return `
      <div class="page-head"><div><h1>Stock adjustment</h1><p class="sub">Corrections for weight loss, sampling, damage or count differences. A reason is always recorded.</p></div></div>
      ${setupNeeded()}
      <div id="postedNote"></div>
      <form class="card form" id="adjustForm">
        <div class="form-grid">
          <label>Date<input type="date" name="date" value="${today()}" max="${today()}" required></label>
          <label>Godown<select name="locationId" required>${options(active(M.godowns), "", g => g.name, "Select")}</select></label>
          <label class="span-2">Lot<select name="lotId" required></select></label>
          <fieldset class="span-2 seg"><legend>Direction</legend>
            <label><input type="radio" name="direction" value="OUT" checked> Decrease (loss)</label>
            <label><input type="radio" name="direction" value="IN"> Increase (gain)</label>
          </fieldset>
          <label>Bags<input type="number" name="bags" min="0" step="1" value="0"></label>
          <label>Weight (kg)<input type="number" name="kg" min="0" step="0.001" value="0"></label>
          <label class="span-2">Reason<select name="reason" required>${plainOptions(reasons, "", "Select reason")}</select></label>
          <label class="span-2">Reference<input name="reference" maxlength="80"></label>
          <label class="span-2">Notes<textarea name="notes" rows="2" maxlength="300"></textarea></label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Post adjustment</button></div>
      </form>`;
  }

  /* ---------- ledger ---------- */

  function txnRow(t, withActions) {
    const net = t.entries.reduce((s, e) => s + e.grams, 0);
    const isTransfer = t.type === "TRANSFER";
    const moved = isTransfer ? t.entries.filter(e => e.grams > 0).reduce((s, e) => s + e.grams, 0) : net;
    const lots = [...new Set(t.entries.map(e => e.lotCode))].join(", ");
    const out = t.entries.find(e => e.grams < 0), inn = t.entries.find(e => e.grams > 0);
    const where = isTransfer && out && inn ? `${esc(godownName(out.locationId))} → ${esc(godownName(inn.locationId))}`
      : [...new Set(t.entries.map(e => godownName(e.locationId)))].map(esc).join(", ");
    const canReverse = withActions && can.manage() && t.status === "POSTED" && t.type !== "REVERSAL" && t.type !== "DISPATCH";
    return `<tr><td class="mono">${t.dispatchId ? `<a href="#/dispatch/${esc(t.dispatchId)}">${esc(t.no)}</a>` : esc(t.no)}</td><td>${fmtDate(t.date)}</td><td>${esc(t.type)}</td>
      <td>${where} · <span class="mono">${esc(lots)}</span>${t.reason ? `<div class="muted">${esc(t.reason)}</div>` : ""}${t.reference ? `<div class="muted">Ref: ${esc(t.reference)}</div>` : ""}${t.postedBy ? `<div class="muted">by ${esc(t.postedBy)}</div>` : ""}</td>
      <td class="r mono ${isTransfer ? "" : moved < 0 ? "neg" : "pos"}">${!isTransfer && moved > 0 ? "+" : ""}${kg(moved)}</td><td>${badge(t.status)}</td>
      ${withActions ? `<td>${canReverse ? `<button class="btn small ghost" data-reverse="${esc(t.id)}" data-no="${esc(t.no)}">Reverse</button>` : ""}</td>` : ""}</tr>`;
  }

  function txnTable(list, { withActions = false } = {}) {
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Details</th><th class="r">kg</th><th>Status</th>${withActions ? "<th></th>" : ""}</tr></thead>
      <tbody id="txnBody">${list.map(t => txnRow(t, withActions)).join("")}</tbody></table></div>`;
  }

  async function ledgerView() {
    const type = query().get("t") || "";
    const path = o => `/transactions?limit=50&offset=${o}${type ? `&type=${type}` : ""}`;
    const first = await Api.get(path(0));
    let offset = first.transactions.length;
    then(() => {
      document.getElementById("ledgerFilter").addEventListener("change", e => { location.hash = `#/ledger?t=${encodeURIComponent(e.target.value)}`; });
      document.getElementById("ledgerList").addEventListener("click", async e => {
        const btn = e.target.closest("[data-reverse]");
        if (!btn) return;
        const reason = prompt(`Reverse ${btn.dataset.no}? This posts an opposite movement. Enter a reason:`);
        if (reason == null) return;
        if (await attempt(() => Api.post(`/transactions/${btn.dataset.reverse}/reverse`, { reason }), `${btn.dataset.no} reversed`, btn)) render();
      });
      const more = document.getElementById("moreTxn");
      if (more) more.addEventListener("click", async () => {
        const r = await attempt(() => Api.get(path(offset)), null, more);
        if (!r) return;
        offset += r.transactions.length;
        document.getElementById("txnBody").insertAdjacentHTML("beforeend", r.transactions.map(t => txnRow(t, true)).join(""));
        if (!r.hasMore) more.remove();
      });
      document.getElementById("exportLedger").addEventListener("click", e => attempt(() => Api.download("/exports/ledger.csv", "stock-ledger.csv"), null, e.currentTarget));
    });
    return `
      <div class="page-head"><div><h1>Stock ledger</h1><p class="sub">Every posted movement. Posted records are never edited — mistakes are reversed with an opposite entry.</p></div>
        <div class="actions"><button class="btn" id="exportLedger">Export CSV</button></div></div>
      <form class="filters"><label>Type<select id="ledgerFilter">${plainOptions(["OPENING", "RECEIPT", "TRANSFER", "ADJUSTMENT", "DISPATCH", "REVERSAL"], type, "All types")}</select></label></form>
      <section class="card flush" id="ledgerList">${first.transactions.length ? txnTable(first.transactions, { withActions: true }) : `<div class="empty">No transactions yet.</div>`}
        ${first.hasMore ? `<div class="pad-row"><button class="btn small" id="moreTxn">Load more</button></div>` : ""}</section>`;
  }

  /* ---------- dispatch ---------- */

  function dispatchTable(list) {
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Dispatch</th><th>Date</th><th>Client</th><th>Vehicle</th><th class="r">kg</th><th class="r">Bags</th><th class="r">Pkgs</th><th>Status</th></tr></thead><tbody>
      ${list.map(d => `<tr><td class="mono"><a href="#/dispatch/${esc(d.id)}">${esc(d.no)}</a></td><td>${fmtDate(d.date)}</td><td>${esc(d.clientName)}</td><td class="mono">${esc(d.vehicleNo || "–")}</td>
        <td class="r mono">${kg(d.grams)}</td><td class="r mono">${num(d.bags)}</td><td class="r">${d.packages || "–"}</td><td>${badge(d.status)}</td></tr>`).join("")}
    </tbody></table></div>`;
  }

  async function dispatchList() {
    const st = query().get("s") || "";
    const r = await Api.get(`/dispatches?limit=100${st ? `&status=${st}` : ""}`);
    then(() => {
      document.getElementById("dispFilter").addEventListener("change", e => { location.hash = `#/dispatches?s=${encodeURIComponent(e.target.value)}`; });
      document.getElementById("exportDisp").addEventListener("click", e => attempt(() => Api.download("/exports/dispatches.csv", "dispatch-register.csv"), null, e.currentTarget));
    });
    return `
      <div class="page-head"><div><h1>Dispatches</h1><p class="sub">Coffee sent to clients. Each package carries its own barcode.</p></div>
        <div class="actions"><button class="btn" id="exportDisp">Export CSV</button>${can.post() ? `<a class="btn primary" href="#/dispatch/new">+ New dispatch</a>` : ""}</div></div>
      <form class="filters"><label>Status<select id="dispFilter">${plainOptions(["DRAFT", "DISPATCHED", "CANCELLED", "REVERSED"], st, "All")}</select></label></form>
      <section class="card flush">${r.dispatches.length ? dispatchTable(r.dispatches) : `<div class="empty">No dispatches yet.${can.post() ? ` <a href="#/dispatch/new">Create one</a>.` : ""}</div>`}
        ${r.hasMore ? `<p class="muted pad-row">Showing the latest 100. Use Export CSV for the full register.</p>` : ""}</section>`;
  }

  async function dispatchForm(id) {
    if (!can.post()) return `<div class="empty">Your role cannot create dispatches.</div>`;
    const d = id ? await Api.get(`/dispatches/${encodeURIComponent(id)}`) : null;
    if (d && d.status !== "DRAFT") return `<div class="empty">Only draft dispatches can be edited. <a href="#/dispatch/${esc(d.id)}">Back</a></div>`;
    const clients = active(M.clients);
    const godowns = postGodowns();
    const lineHtml = (l = {}) => `
      <div class="line" data-line>
        <label>Godown<select name="locationId" required>${options(godowns, l.locationId, g => g.name, "Select")}</select></label>
        <label class="grow">Lot<select name="lotId" required data-keep="${esc(l.lotId || "")}"></select></label>
        <label>Bags<input type="number" name="bags" min="0" step="1" value="${l.bags != null ? l.bags : ""}" required></label>
        <label>Net kg<input type="number" name="kg" min="0.001" step="0.001" value="${l.grams != null ? l.grams / 1000 : ""}" required ${l.grams != null ? 'data-touched="1"' : ""}></label>
        <label title="Number of barcode labels for this line. Normally one per bag.">Packages<input type="number" name="packages" min="1" step="1" value="${l.packages || ""}" placeholder="= bags"></label>
        <button type="button" class="btn small ghost" data-remove aria-label="Remove line">✕</button>
      </div>`;
    then(() => {
      const f = document.getElementById("dispatchForm");
      const lines = document.getElementById("lines");
      const fill = row => {
        const sel = row.querySelector("[name=lotId]");
        return fillLotPicker(sel, row.querySelector("[name=locationId]").value, { exceptDispatch: d && d.id, keep: sel.value || sel.dataset.keep });
      };
      lines.querySelectorAll("[data-line]").forEach(fill);
      lines.addEventListener("change", e => { if (e.target.name === "locationId") fill(e.target.closest("[data-line]")); });
      lines.addEventListener("input", e => {
        const row = e.target.closest("[data-line]");
        const kgEl = row.querySelector("[name=kg]");
        if (e.target === kgEl) kgEl.dataset.touched = "1";
        if (e.target.name !== "bags" || kgEl.dataset.touched) return;
        const opt = row.querySelector("[name=lotId]").selectedOptions[0];
        const it = opt && byId(M.items, opt.dataset.item);
        if (it && it.bagGrams) kgEl.value = (Number(e.target.value || 0) * it.bagGrams) / 1000 || "";
      });
      lines.addEventListener("click", e => {
        if (e.target.matches("[data-remove]") && lines.children.length > 1) e.target.closest("[data-line]").remove();
      });
      document.getElementById("addLine").addEventListener("click", () => {
        lines.insertAdjacentHTML("beforeend", lineHtml());
        fill(lines.lastElementChild);
      });
      f.clientId.addEventListener("change", () => {
        const c = byId(M.clients, f.clientId.value);
        if (c && !f.destination.value) f.destination.value = c.address;
      });
      f.addEventListener("submit", async e => {
        e.preventDefault();
        const data = formData(f);
        const body = {
          clientId: data.clientId, date: data.date, destination: data.destination, vehicleNo: data.vehicleNo, transporter: data.transporter,
          driverName: data.driverName, driverPhone: data.driverPhone, reference: data.reference, notes: data.notes,
          lines: [...lines.querySelectorAll("[data-line]")].map(row => {
            const pk = row.querySelector("[name=packages]").value;
            return {
              locationId: row.querySelector("[name=locationId]").value,
              lotId: row.querySelector("[name=lotId]").value,
              bags: Number(row.querySelector("[name=bags]").value || 0),
              grams: toGrams(row.querySelector("[name=kg]").value),
              ...(pk ? { packages: Number(pk) } : {})
            };
          })
        };
        const saved = await attempt(() => d ? Api.put(`/dispatches/${d.id}`, body) : Api.post("/dispatches", body),
          d ? "Draft updated" : "Draft saved — barcodes issued", f.querySelector("[type=submit]"));
        if (saved) location.hash = `#/dispatch/${saved.id}`;
      });
    });
    return `
      <div class="page-head"><div><div class="crumb"><a href="#/dispatches">Dispatches</a> / ${d ? esc(d.no) : "New"}</div>
        <h1>${d ? "Edit draft dispatch" : "New dispatch"}</h1><p class="sub">Saving the draft holds the stock and issues one barcode per package. Post it when the vehicle leaves.</p></div></div>
      ${setupNeeded()}${!clients.length ? `<div class="notice">Add a <a href="#/masters/clients">client</a> first.</div>` : ""}
      ${d && d.packages.some(p => p.printCount) ? `<div class="notice">Labels for this draft were already printed. Changing godown, lot, bags, kg or package count will retire those barcodes and issue new ones — reprint and replace the labels.</div>` : ""}
      <form class="card form" id="dispatchForm">
        <h2>Consignee &amp; transport</h2>
        <div class="form-grid">
          <label class="span-2">Client<select name="clientId" required>${options(clients, d && d.client.id, c => `${c.name} (${c.code})`, "Select client")}</select></label>
          <label>Dispatch date<input type="date" name="date" value="${esc(d ? d.date : today())}" required></label>
          <label>Client order / reference<input name="reference" value="${esc(d ? d.reference : "")}" maxlength="80"></label>
          <label class="span-2">Delivery address / destination<textarea name="destination" rows="2" maxlength="300">${esc(d ? d.destination : "")}</textarea></label>
          <label>Vehicle no.<input name="vehicleNo" value="${esc(d ? d.vehicleNo : "")}" maxlength="20" placeholder="KA 12 AB 3456"></label>
          <label>Transporter<input name="transporter" value="${esc(d ? d.transporter : "")}" maxlength="80"></label>
          <label>Driver name<input name="driverName" value="${esc(d ? d.driverName : "")}" maxlength="60"></label>
          <label>Driver phone<input name="driverPhone" value="${esc(d ? d.driverPhone : "")}" maxlength="20" inputmode="tel"></label>
          <label class="span-2">Notes<textarea name="notes" rows="2" maxlength="500">${esc(d ? d.notes : "")}</textarea></label>
        </div>
        <h2>What is going</h2>
        <div id="lines">${(d ? d.lines : [{}]).map(lineHtml).join("")}</div>
        <button type="button" class="btn small" id="addLine">+ Add line</button>
        <div class="form-actions">
          <a class="btn ghost" href="${d ? `#/dispatch/${esc(d.id)}` : "#/dispatches"}">Cancel</a>
          <button class="btn primary" type="submit">${d ? "Save changes" : "Save draft & issue barcodes"}</button>
        </div>
      </form>`;
  }

  async function dispatchDetail(id) {
    const d = await Api.get(`/dispatches/${encodeURIComponent(id)}`);
    const c = d.client;
    const pk = d.packages;
    const tot = d.lines.reduce((s, l) => ({ grams: s.grams + l.grams, bags: s.bags + l.bags }), { grams: 0, bags: 0 });
    const draft = d.status === "DRAFT";
    const update = r => { if (r) render(); };
    then(() => {
      view.querySelector(".page-actions").addEventListener("click", async e => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "post") {
          if (!confirm(`Post ${d.no}? Stock will be deducted and the ${pk.length} package barcodes become final.`)) return;
          update(await attempt(() => Api.post(`/dispatches/${d.id}/post`), `${d.no} dispatched`, btn));
        } else if (act === "cancel") {
          const reason = prompt(`Cancel draft ${d.no}? Held stock is released and its barcodes retired. Reason (optional):`);
          if (reason == null) return;
          update(await attempt(() => Api.post(`/dispatches/${d.id}/cancel`, { reason }), "Draft cancelled", btn));
        } else if (act === "reverse") {
          const reason = prompt(`Reverse ${d.no}? Use this only if the goods did NOT leave. Stock returns to the godown and barcodes are retired. Reason:`);
          if (reason == null) return;
          update(await attempt(() => Api.post(`/dispatches/${d.id}/reverse`, { reason }), `${d.no} reversed`, btn));
        } else if (act === "labels") printLabels(d, pk);
        else if (act === "note") printDispatchNote(d);
      });
      const wf = document.getElementById("weightsForm");
      if (wf) wf.addEventListener("submit", async e => {
        e.preventDefault();
        const weights = {};
        wf.querySelectorAll("[data-pkg]").forEach(inp => {
          const p = pk.find(x => x.id === inp.dataset.pkg);
          if (toGrams(inp.value) !== p.grams) weights[p.id] = toGrams(inp.value);
        });
        if (!Object.keys(weights).length) return toast("No weights changed.");
        update(await attempt(() => Api.put(`/dispatches/${d.id}/package-weights`, { weights }), "Package weights saved", wf.querySelector("[type=submit]")));
      });
      view.querySelectorAll("[data-print-one]").forEach(b => b.addEventListener("click", () => printLabels(d, [pk.find(p => p.id === b.dataset.printOne)])));
    });
    return `
      <div class="page-head">
        <div><div class="crumb"><a href="#/dispatches">Dispatches</a> / ${esc(d.no)}</div>
          <h1><span class="mono">${esc(d.no)}</span> ${badge(d.status)}</h1>
          <p class="sub">${esc(c.name)} · ${fmtDate(d.date)} · ${kg(tot.grams)} kg · ${num(tot.bags)} bags · ${pk.length} packages</p></div>
        <div class="actions page-actions">
          ${pk.length ? `<button class="btn" data-act="labels">Print labels (${pk.length})</button>` : ""}
          <button class="btn" data-act="note">Print dispatch note</button>
          ${draft && can.post() ? `<a class="btn" href="#/dispatch/${esc(d.id)}/edit">Edit</a><button class="btn danger ghost" data-act="cancel">Cancel draft</button><button class="btn primary" data-act="post">Post dispatch</button>` : ""}
          ${d.status === "DISPATCHED" && can.manage() ? `<button class="btn danger ghost" data-act="reverse">Reverse</button>` : ""}
        </div>
      </div>
      ${draft ? `<div class="notice">Draft: stock is held for this dispatch but not yet deducted. Print and stick the labels, check weights, then <strong>Post dispatch</strong> when the vehicle leaves.</div>` : ""}
      ${d.status === "REVERSED" ? `<div class="notice warn">Reversed: ${esc(d.statusReason)}. Stock was returned to the godown; barcodes are retired.</div>` : ""}
      ${d.status === "CANCELLED" ? `<div class="notice warn">Cancelled draft${d.statusReason ? `: ${esc(d.statusReason)}` : ""}. Barcodes are retired.</div>` : ""}
      <div class="grid-2">
        <section class="card"><h2>Consignee</h2>
          <dl class="facts one">
            <div><dt>Client</dt><dd>${esc(c.name)} <span class="muted mono">${esc(c.code)}</span></dd></div>
            <div><dt>Deliver to</dt><dd class="pre">${esc(d.destination || "–")}</dd></div>
            ${c.contactPerson || c.phone ? `<div><dt>Contact</dt><dd>${esc([c.contactPerson, c.phone].filter(Boolean).join(" · "))}</dd></div>` : ""}
            ${c.gstin ? `<div><dt>GSTIN</dt><dd class="mono">${esc(c.gstin)}</dd></div>` : ""}
            ${d.reference ? `<div><dt>Client ref.</dt><dd>${esc(d.reference)}</dd></div>` : ""}
          </dl></section>
        <section class="card"><h2>Transport</h2>
          <dl class="facts one">
            <div><dt>Vehicle</dt><dd class="mono">${esc(d.vehicleNo || "–")}</dd></div>
            <div><dt>Transporter</dt><dd>${esc(d.transporter || "–")}</dd></div>
            <div><dt>Driver</dt><dd>${esc([d.driverName, d.driverPhone].filter(Boolean).join(" · ") || "–")}</dd></div>
            <div><dt>Created</dt><dd>${fmtTime(d.createdAt)}${d.createdBy ? ` by ${esc(d.createdBy)}` : ""}</dd></div>
            ${d.postedAt ? `<div><dt>Posted</dt><dd>${fmtTime(d.postedAt)}${d.postedBy ? ` by ${esc(d.postedBy)}` : ""}</dd></div>` : ""}
            ${d.notes ? `<div><dt>Notes</dt><dd class="pre">${esc(d.notes)}</dd></div>` : ""}
          </dl></section>
      </div>
      <section class="card flush"><h2>Lines</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Godown</th><th>Lot</th><th>Item</th><th class="r">Bags</th><th class="r">Net kg</th><th class="r">Packages</th>${draft ? "<th>Packages add up?</th>" : ""}</tr></thead><tbody>
        ${d.lines.map(l => `<tr><td>${l.lineNo}</td><td>${esc(l.godownName)}</td><td class="mono"><a href="#/lot/${esc(l.lotId)}">${esc(l.lotCode)}</a></td><td>${esc(l.itemName)}</td>
          <td class="r mono">${num(l.bags)}</td><td class="r mono">${kg(l.grams)}</td><td class="r">${l.packages}</td>
          ${draft ? `<td>${l.reconciles ? `<span class="badge green">Yes</span>` : `<span class="badge red">Packages ${kg(l.packageGrams)} kg / ${l.packageBags} bags</span>`}</td>` : ""}</tr>`).join("")}
        </tbody></table></div>
      </section>
      <section class="card flush"><h2>Packages &amp; barcodes</h2>
        <form id="weightsForm">
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Package</th><th>Barcode</th><th>Lot</th><th class="r">Bags</th><th class="r">Net kg</th><th>Status</th><th class="r">Printed</th><th></th></tr></thead><tbody>
        ${pk.map(p => `<tr><td class="mono">${p.seq} of ${pk.length}</td><td><a class="mono" href="#/track/${esc(p.barcode)}">${esc(p.barcode)}</a></td><td class="mono">${esc(p.lotCode)}</td><td class="r mono">${p.bags}</td>
          <td class="r">${draft && can.post() ? `<input class="wt" type="number" min="0.001" step="0.001" value="${p.grams / 1000}" data-pkg="${esc(p.id)}" aria-label="Net kg for package ${p.seq}">` : `<span class="mono">${kg(p.grams)}</span>`}</td>
          <td>${badge(p.status)}</td><td class="r">${p.printCount || 0}×</td><td><button type="button" class="btn small ghost" data-print-one="${esc(p.id)}">Label</button></td></tr>`).join("")}
        </tbody></table></div>
        ${draft && can.post() ? `<div class="form-actions pad-row"><span class="muted">Weighed each bag? Enter actual net kg per package; totals must match the line before posting.</span><button class="btn" type="submit">Save weights</button></div>` : ""}
        </form>
      </section>`;
  }

  /* ---------- printing ---------- */

  function printNow(html, pageCss) {
    printRoot.innerHTML = `<style>@page { ${pageCss} }</style>${html}`;
    document.body.classList.add("printing");
    const done = () => { document.body.classList.remove("printing"); printRoot.innerHTML = ""; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 50);
  }

  function labelHtml(d, p, count) {
    const line = d.lines.find(l => l.id === p.lineId) || d.lines[0] || {};
    return `<div class="label">
      <div class="lb-top"><span class="lb-org">${esc(M.org.name)}</span><span class="lb-pkg">PKG ${p.seq} / ${count}</span></div>
      <div class="lb-to"><span class="lb-k">TO</span> <strong>${esc(d.client.name)}</strong><div class="lb-addr">${esc((d.destination || "").split("\n")[0])}</div></div>
      <div class="lb-grid">
        <div><span class="lb-k">Dispatch</span><b>${esc(d.no)}</b></div>
        <div><span class="lb-k">Date</span><b>${fmtDate(d.date)}</b></div>
        <div><span class="lb-k">Vehicle</span><b>${esc(d.vehicleNo || "–")}</b></div>
        <div class="span-3"><span class="lb-k">Coffee</span><b>${esc(line.itemName || "")}</b> ${esc(itemMeta(line))}</div>
        <div><span class="lb-k">Lot</span><b>${esc(p.lotCode)}</b></div>
        <div><span class="lb-k">Net wt</span><b>${kg(p.grams)} kg</b></div>
        <div><span class="lb-k">Bags</span><b>${p.bags}</b></div>
      </div>
      <div class="lb-code">${Code128.svg(p.barcode, { moduleWidth: 2, height: 50 })}</div>
      <div class="lb-value">${esc(p.barcode)}</div>
    </div>`;
  }

  function printLabels(d, pk) {
    if (!pk.length) return;
    const w = Number(M.org.labelWidthMm), h = Number(M.org.labelHeightMm);
    printNow(`<div class="labels" style="--lw:${w}mm;--lh:${h}mm">${pk.map(p => labelHtml(d, p, d.packages.length)).join("")}</div>`, `size: ${w}mm ${h}mm; margin: 0;`);
    Api.post(`/dispatches/${d.id}/printed`, { packageIds: pk.map(p => p.id) }).then(() => setTimeout(render, 300)).catch(() => {});
  }

  function printDispatchNote(d) {
    const c = d.client;
    const pk = d.status === "DRAFT" || d.status === "DISPATCHED" ? d.packages : [];
    const tot = d.lines.reduce((s, l) => ({ grams: s.grams + l.grams, bags: s.bags + l.bags }), { grams: 0, bags: 0 });
    const html = `<div class="note">
      <header class="nt-head"><div><div class="nt-org">${esc(M.org.name)}</div><div class="nt-sub">${esc(M.org.address || "")}</div></div>
        <div class="nt-title">DISPATCH NOTE${d.status === "DRAFT" ? " <span>(DRAFT — not yet posted)</span>" : ""}${d.status === "REVERSED" || d.status === "CANCELLED" ? ` <span>(${esc(d.status)})</span>` : ""}</div></header>
      <div class="nt-meta">
        <div><span>Dispatch no.</span><b>${esc(d.no)}</b></div><div><span>Date</span><b>${fmtDate(d.date)}</b></div>
        <div><span>Vehicle no.</span><b>${esc(d.vehicleNo || "")}</b></div><div><span>Transporter</span><b>${esc(d.transporter || "")}</b></div>
        <div><span>Driver</span><b>${esc([d.driverName, d.driverPhone].filter(Boolean).join(" · "))}</b></div><div><span>Client ref.</span><b>${esc(d.reference || "")}</b></div>
      </div>
      <div class="nt-to"><span>Consignee</span><b>${esc(c.name)}</b>${c.gstin ? ` · GSTIN ${esc(c.gstin)}` : ""}<div class="pre">${esc(d.destination || c.address || "")}</div></div>
      <table class="nt-tbl"><thead><tr><th>#</th><th>Coffee</th><th>Lot</th><th>From godown</th><th class="r">Bags</th><th class="r">Net kg</th></tr></thead><tbody>
        ${d.lines.map(l => `<tr><td>${l.lineNo}</td><td>${esc(l.itemName)}<div class="muted">${esc(itemMeta(l))}</div></td><td>${esc(l.lotCode)}</td><td>${esc(l.godownName)}</td><td class="r">${num(l.bags)}</td><td class="r">${kg(l.grams)}</td></tr>`).join("")}
      </tbody><tfoot><tr><td colspan="4">Total</td><td class="r">${num(tot.bags)}</td><td class="r">${kg(tot.grams)}</td></tr></tfoot></table>
      ${pk.length ? `<h3>Packages (${pk.length}) — scan any label to trace</h3>
      <div class="nt-pkgs">${pk.map(p => `<div class="nt-pkg"><div class="nt-pkg-code">${Code128.svg(p.barcode, { moduleWidth: 1, height: 26 })}</div><div><b>${p.seq}/${pk.length}</b> ${esc(p.barcode)}<br>${esc(p.lotCode)} · ${kg(p.grams)} kg · ${p.bags} bag${p.bags === 1 ? "" : "s"}</div></div>`).join("")}</div>` : ""}
      ${d.notes ? `<p><b>Notes:</b> ${esc(d.notes)}</p>` : ""}
      <div class="nt-sign"><div>Prepared by</div><div>Checked by (godown)</div><div>Driver</div><div>Received by (consignee)</div></div>
    </div>`;
    printNow(html, "size: A4; margin: 12mm;");
  }

  /* ---------- track ---------- */

  async function trackView(code) {
    const t = code ? await Api.get(`/trace/${encodeURIComponent(code)}`) : null;
    then(() => {
      const f = document.getElementById("trackForm");
      f.addEventListener("submit", e => { e.preventDefault(); const v = f.code.value.trim(); if (v) location.hash = `#/track/${encodeURIComponent(v)}`; });
      if (!code) f.code.focus();
    });
    let body = "";
    if (t && !t.found) {
      body = `<div class="notice warn">No package found for <span class="mono">${esc(t.value)}</span>.${t.validFormat ? "" : " The code does not look valid — check for a mistyped character."}</div>`;
    } else if (t) {
      const p = t.package, d = t.dispatch;
      const steps = [
        ...t.receipts.map(r => ({ at: r.postedAt, text: `${r.type === "OPENING" ? "Opening stock" : "Received"} into ${r.godownName}`, ref: r.no })),
        { at: p.createdAt, text: "Package created, barcode issued", ref: d.no },
        ...(p.dispatchedAt ? [{ at: p.dispatchedAt, text: `Dispatched to ${t.client.name}${d.vehicleNo ? ` on vehicle ${d.vehicleNo}` : ""}`, ref: d.no }] : []),
        ...(p.cancelledAt ? [{ at: p.cancelledAt, text: d.status === "REVERSED" ? `Dispatch reversed: ${d.statusReason}` : "Barcode retired (draft changed or cancelled)", ref: "" }] : [])
      ].sort((a, b) => a.at.localeCompare(b.at));
      body = `
        <section class="card trace">
          <div class="trace-head"><div class="trace-code">${Code128.svg(p.barcode, { moduleWidth: 2, height: 46 })}<div class="mono">${esc(p.barcode)}</div></div>
            <div><div class="muted">Package</div><div class="big mono">${esc(t.packageNo)}</div><div>${p.seq} of ${t.packageCount} · ${badge(p.status)}</div></div></div>
          <dl class="facts">
            <div><dt>Client</dt><dd>${esc(t.client.name)}</dd></div>
            <div><dt>Dispatch</dt><dd><a class="mono" href="#/dispatch/${esc(d.id)}">${esc(d.no)}</a> ${badge(d.status)}</dd></div>
            <div><dt>Dispatch date</dt><dd>${fmtDate(d.date)}</dd></div>
            <div><dt>Vehicle / driver</dt><dd>${esc([d.vehicleNo, d.driverName].filter(Boolean).join(" · ") || "–")}</dd></div>
            <div><dt>Deliver to</dt><dd class="pre">${esc(d.destination || "–")}</dd></div>
            <div><dt>Coffee</dt><dd>${esc(t.item.name)}<div class="muted">${esc(itemMeta(t.item))}</div></dd></div>
            <div><dt>Lot</dt><dd><a class="mono" href="#/lot/${esc(t.lot.id)}">${esc(t.lot.code)}</a>${t.lot.cropYear ? ` · ${esc(t.lot.cropYear)}` : ""}</dd></div>
            <div><dt>From godown</dt><dd>${esc(t.godown ? t.godown.name : "–")}</dd></div>
            <div><dt>Net weight / bags</dt><dd>${kg(p.grams)} kg · ${p.bags} bag${p.bags === 1 ? "" : "s"}</dd></div>
            <div><dt>Source</dt><dd>${esc(t.lot.sourceRef || t.lot.sourceType)}</dd></div>
          </dl>
          <h2>History</h2>
          <ol class="timeline">${steps.map(s => `<li><span class="t-at">${fmtTime(s.at)}</span><span>${esc(s.text)}</span>${s.ref ? `<span class="mono muted">${esc(s.ref)}</span>` : ""}</li>`).join("")}</ol>
        </section>`;
    }
    return `
      <div class="page-head"><div><h1>Track a package</h1><p class="sub">Scan a label with a USB/Bluetooth scanner or type the code printed under the barcode.</p></div></div>
      <form class="card form track-form" id="trackForm"><label class="grow">Barcode<input name="code" class="mono" value="${esc(t ? t.value : "")}" placeholder="PKG-XXXXXXXXXXX" autocomplete="off"></label><button class="btn primary" type="submit">Track</button></form>
      ${body}`;
  }

  /* ---------- masters ---------- */

  const MASTER = {
    godowns: {
      title: "Godowns", one: "godown",
      cols: [["code", "Code"], ["name", "Name"], ["address", "Address"]],
      fields: g => `
        <label>Code<input name="code" value="${esc(g.code)}" required maxlength="30"></label>
        <label>Name<input name="name" value="${esc(g.name)}" required maxlength="80"></label>
        <label class="span-2">Address<input name="address" value="${esc(g.address)}" maxlength="200"></label>`,
      body: d => ({ code: d.code, name: d.name, address: d.address })
    },
    items: {
      title: "Coffee items", one: "item",
      cols: [["code", "Code"], ["name", "Name"], ["coffeeType", "Type"], ["form", "Form"], ["grade", "Grade"], ["bagGrams", "Std bag kg", g => g ? kg(g) : ""]],
      fields: it => `
        <label>Code<input name="code" value="${esc(it.code)}" required maxlength="30" placeholder="ARA-PCH-A"></label>
        <label>Name<input name="name" value="${esc(it.name)}" required maxlength="80" placeholder="Arabica Parchment A"></label>
        <label>Coffee type<select name="coffeeType">${plainOptions(["Arabica", "Robusta"], it.coffeeType, "Select")}</select></label>
        <label>Form<select name="form">${plainOptions(["Parchment", "Cherry", "Clean / Green", "Other"], it.form, "Select")}</select></label>
        <label>Grade<input name="grade" value="${esc(it.grade)}" maxlength="20" placeholder="A, AB, PB…"></label>
        <label>Standard bag (kg)<input type="number" name="bagKg" value="${it.bagGrams ? it.bagGrams / 1000 : ""}" min="0" step="0.1" placeholder="50"></label>`,
      body: d => ({ code: d.code, name: d.name, coffeeType: d.coffeeType, form: d.form, grade: d.grade, bagGrams: d.bagKg ? toGrams(d.bagKg) : null })
    },
    clients: {
      title: "Clients", one: "client",
      cols: [["code", "Code"], ["name", "Name"], ["contactPerson", "Contact"], ["phone", "Phone"], ["gstin", "GSTIN"]],
      fields: c => `
        <label>Code<input name="code" value="${esc(c.code)}" required maxlength="30"></label>
        <label>Name<input name="name" value="${esc(c.name)}" required maxlength="80"></label>
        <label>Contact person<input name="contactPerson" value="${esc(c.contactPerson)}" maxlength="80"></label>
        <label>Phone<input name="phone" value="${esc(c.phone)}" maxlength="30" inputmode="tel"></label>
        <label class="span-2">Delivery address<textarea name="address" rows="2" maxlength="300">${esc(c.address)}</textarea></label>
        <label>GSTIN<input name="gstin" value="${esc(c.gstin)}" maxlength="15"></label>`,
      body: d => ({ code: d.code, name: d.name, contactPerson: d.contactPerson, phone: d.phone, address: d.address, gstin: d.gstin })
    }
  };

  async function mastersView(kind, editId) {
    const m = MASTER[kind];
    const list = M[kind];
    const rec = editId && editId !== "new" ? byId(list, editId) : null;
    const showForm = can.manage() && (editId === "new" || rec);
    then(() => {
      const f = document.getElementById("masterForm");
      if (!f) return;
      f.querySelector("input").focus();
      f.addEventListener("submit", async e => {
        e.preventDefault();
        const d = formData(f);
        const body = { ...m.body(d), active: d.active === "on" };
        const saved = await attempt(() => rec ? Api.put(`/${kind}/${rec.id}`, body) : Api.post(`/${kind}`, body),
          `${m.one[0].toUpperCase() + m.one.slice(1)} saved`, f.querySelector("[type=submit]"));
        if (saved) { await loadMasters(); location.hash = `#/masters/${kind}`; }
      });
    });
    return `
      <div class="page-head"><div><h1>Masters</h1><p class="sub">Reference data. Records in use are deactivated, never deleted.</p></div>
        ${can.manage() ? `<div class="actions"><a class="btn primary" href="#/masters/${kind}/new">+ Add ${m.one}</a></div>` : ""}</div>
      <div class="tabs">${Object.entries(MASTER).map(([k, v]) => `<a href="#/masters/${k}" class="${k === kind ? "active" : ""}">${v.title}</a>`).join("")}</div>
      ${showForm ? `<form class="card form" id="masterForm"><h2>${rec ? "Edit" : "New"} ${m.one}</h2><div class="form-grid">${m.fields(rec || {})}
        <label class="check span-2"><input type="checkbox" name="active" ${!rec || rec.active !== false ? "checked" : ""}> Active</label></div>
        <div class="form-actions"><a class="btn ghost" href="#/masters/${kind}">Cancel</a><button class="btn primary" type="submit">Save</button></div></form>` : ""}
      <section class="card flush">${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${m.cols.map(([, h]) => `<th>${h}</th>`).join("")}<th>Status</th>${can.manage() ? "<th></th>" : ""}</tr></thead><tbody>
        ${list.map(r => `<tr class="${r.active === false ? "inactive" : ""}">${m.cols.map(([k, , fmt]) => `<td class="${k === "code" || k === "gstin" ? "mono" : ""}">${esc(fmt ? fmt(r[k]) : r[k] == null ? "" : r[k])}</td>`).join("")}<td>${badge(r.active === false ? "INACTIVE" : "ACTIVE")}</td>
          ${can.manage() ? `<td><a class="btn small ghost" href="#/masters/${kind}/${esc(r.id)}">Edit</a></td>` : ""}</tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No ${m.title.toLowerCase()} yet.</div>`}</section>`;
  }

  /* ---------- users (admin) ---------- */

  async function usersView(editId) {
    if (!can.admin()) return `<div class="empty">Only administrators manage users.</div>`;
    const { users } = await Api.get("/users");
    const rec = editId && editId !== "new" ? byId(users, editId) : null;
    const showForm = editId === "new" || rec;
    const godownChecks = sel => active(M.godowns).map(g => `<label class="check"><input type="checkbox" name="godown" value="${esc(g.id)}" ${sel.includes(g.id) ? "checked" : ""}> ${esc(g.name)}</label>`).join("") || `<span class="muted">No godowns yet.</span>`;
    then(() => {
      const f = document.getElementById("userForm");
      if (!f) return;
      const syncRole = () => { f.querySelector("[data-godowns]").hidden = f.role.value !== "operator"; };
      f.role.addEventListener("change", syncRole);
      syncRole();
      f.addEventListener("submit", async e => {
        e.preventDefault();
        const d = formData(f);
        const godownIds = [...f.querySelectorAll("[name=godown]:checked")].map(i => i.value);
        const body = { name: d.name, role: d.role, godownIds };
        if (d.password) body.password = d.password;
        if (rec) body.active = d.active === "on";
        else body.login = d.login;
        const ok = await attempt(() => rec ? Api.patch(`/users/${rec.id}`, body) : Api.post("/users", body), "User saved", f.querySelector("[type=submit]"));
        if (ok) location.hash = "#/users";
      });
    });
    return `
      <div class="page-head"><div><h1>Users</h1><p class="sub">Who can sign in, and what they can do. Operators post only in the godowns assigned to them.</p></div>
        <div class="actions"><a class="btn primary" href="#/users/new">+ Add user</a></div></div>
      ${showForm ? `<form class="card form" id="userForm"><h2>${rec ? `Edit ${esc(rec.login)}` : "New user"}</h2><div class="form-grid">
        ${rec ? "" : `<label>Login (email, phone or short ID)<input name="login" required maxlength="120" autocomplete="off"></label>`}
        <label>Full name<input name="name" value="${esc(rec ? rec.name : "")}" required maxlength="80"></label>
        <label>Role<select name="role">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${(rec ? rec.role : "operator") === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>${rec ? "New password (leave blank to keep)" : "Password"}<input name="password" type="password" minlength="8" maxlength="200" ${rec ? "" : "required"} autocomplete="new-password"></label>
        <fieldset class="span-2 seg" data-godowns><legend>Godowns this operator can post in</legend>${godownChecks(rec ? rec.godownIds : [])}</fieldset>
        ${rec ? `<label class="check span-2"><input type="checkbox" name="active" ${rec.active ? "checked" : ""}> Active (can sign in)</label>` : ""}
      </div>
      <div class="role-help muted">Administrator: everything incl. users and settings · Manager: masters, all stock, adjustments, reversals · Godown operator: receive, transfer, dispatch in assigned godowns · Viewer: read only.</div>
      <div class="form-actions"><a class="btn ghost" href="#/users">Cancel</a><button class="btn primary" type="submit">Save</button></div></form>` : ""}
      <section class="card flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Login</th><th>Role</th><th>Godowns</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map(u => `<tr class="${u.active ? "" : "inactive"}"><td>${esc(u.name)}</td><td class="mono">${esc(u.login)}</td><td>${esc(ROLE_LABEL[u.role])}</td>
          <td>${u.role === "operator" ? esc(u.godownIds.map(godownName).join(", ") || "None") : "All"}</td><td>${u.lastSeenAt ? fmtTime(u.lastSeenAt) : "–"}</td>
          <td>${badge(u.active ? "ACTIVE" : "INACTIVE")}</td><td><a class="btn small ghost" href="#/users/${esc(u.id)}">Edit</a></td></tr>`).join("")}
      </tbody></table></div></section>`;
  }

  /* ---------- settings ---------- */

  async function settingsView() {
    const o = M.org;
    then(() => {
      const f = document.getElementById("orgForm");
      if (f) f.addEventListener("submit", async e => {
        e.preventDefault();
        const d = formData(f);
        const org = await attempt(() => Api.patch("/org", { name: d.name, address: d.address, labelWidthMm: Number(d.labelWidthMm), labelHeightMm: Number(d.labelHeightMm) }), "Settings saved", f.querySelector("[type=submit]"));
        if (org) { await loadMasters(); render(); }
      });
      const pf = document.getElementById("pwForm");
      pf.addEventListener("submit", async e => {
        e.preventDefault();
        const d = formData(pf);
        if (d.next !== d.confirm) return toast("New passwords do not match.", "error");
        if (await attempt(() => Api.post("/auth/change-password", { current: d.current, next: d.next }), "Password changed", pf.querySelector("[type=submit]"))) pf.reset();
      });
      document.getElementById("testLabel").addEventListener("click", () => {
        const w = o.labelWidthMm, h = o.labelHeightMm;
        printNow(`<div class="labels" style="--lw:${w}mm;--lh:${h}mm"><div class="label"><div class="lb-top"><span class="lb-org">${esc(o.name)}</span><span class="lb-pkg">TEST LABEL</span></div>
          <div class="lb-to">${w} × ${h} mm — check the bars are sharp and that this code scans.</div><div class="lb-grid"><div class="span-3"><span class="lb-k">Dispatch</span><b>DSP-TEST-00000</b></div></div>
          <div class="lb-code">${Code128.svg("PKG-TEST000000", { moduleWidth: 2, height: 50 })}</div><div class="lb-value">PKG-TEST000000</div></div></div>`, `size: ${w}mm ${h}mm; margin: 0;`);
      });
    });
    const dis = can.admin() ? "" : "disabled";
    return `
      <div class="page-head"><div><h1>Settings</h1></div></div>
      <form class="card form" id="orgForm">
        <h2>Organisation &amp; labels</h2>
        <div class="form-grid">
          <label>Organisation name (on labels &amp; notes)<input name="name" value="${esc(o.name)}" maxlength="80" required ${dis}></label>
          <label class="span-2">Address (on dispatch note)<input name="address" value="${esc(o.address || "")}" maxlength="200" ${dis}></label>
          <label>Label width (mm)<input type="number" name="labelWidthMm" value="${esc(o.labelWidthMm)}" min="40" max="200" ${dis}></label>
          <label>Label height (mm)<input type="number" name="labelHeightMm" value="${esc(o.labelHeightMm)}" min="30" max="200" ${dis}></label>
        </div>
        <div class="form-actions"><button type="button" class="btn ghost" id="testLabel">Print test label</button>${can.admin() ? `<button class="btn primary" type="submit">Save settings</button>` : ""}</div>
      </form>
      <form class="card form" id="pwForm">
        <h2>Change my password</h2>
        <div class="form-grid">
          <label>Current password<input type="password" name="current" required autocomplete="current-password"></label>
          <label>New password<input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
          <label>Confirm new password<input type="password" name="confirm" required minlength="8" autocomplete="new-password"></label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Change password</button></div>
      </form>`;
  }

  /* ---------- downloads ---------- */

  function downloadCsv(name, rows) {
    const cell = v => {
      let s = String(v == null ? "" : v);
      if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; // keep spreadsheet formulas from running
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- sign-in / shell ---------- */

  const loginScreen = document.getElementById("loginScreen");
  const appShell = document.getElementById("appShell");

  function showLogin(message) {
    M.me = null;
    appShell.hidden = true;
    loginScreen.hidden = false;
    document.getElementById("loginError").textContent = message || "";
    loginScreen.querySelector("[name=login]").focus();
  }

  async function startApp() {
    try {
      M.me = await Api.get("/auth/me");
      await loadMasters();
    } catch (e) {
      return showLogin(Api.hasToken() ? e.message : "");
    }
    loginScreen.hidden = true;
    appShell.hidden = false;
    document.getElementById("userName").textContent = M.me.name;
    document.getElementById("userAvatar").textContent = M.me.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
    document.getElementById("userRole").textContent = ROLE_LABEL[M.me.role];
    document.querySelectorAll("[data-can]").forEach(a => { a.hidden = !can[a.dataset.can](); });
    render();
  }

  Api.onUnauthorized(msg => showLogin(msg));

  document.getElementById("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.currentTarget;
    const btn = f.querySelector("[type=submit]");
    btn.disabled = true;
    document.getElementById("loginError").textContent = "";
    try {
      await Api.login(f.login.value, f.password.value);
      f.password.value = "";
      await startApp();
    } catch (err) {
      document.getElementById("loginError").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("signOut").addEventListener("click", () => {
    Api.logout();
    document.getElementById("userPop").hidden = true;
    location.hash = "#/";
    showLogin("");
  });

  const userBtn = document.getElementById("userBtn");
  userBtn.addEventListener("click", () => {
    const pop = document.getElementById("userPop");
    pop.hidden = !pop.hidden;
    userBtn.setAttribute("aria-expanded", String(!pop.hidden));
  });
  document.addEventListener("click", e => {
    if (!e.target.closest(".user-menu")) { document.getElementById("userPop").hidden = true; userBtn.setAttribute("aria-expanded", "false"); }
  });

  // Scanners type the code and press Enter; works from any page.
  document.getElementById("scanForm").addEventListener("submit", e => {
    e.preventDefault();
    const input = document.getElementById("scanInput");
    const v = input.value.trim();
    if (!v) return;
    input.value = "";
    location.hash = `#/track/${encodeURIComponent(v)}`;
  });

  document.getElementById("menuToggle").addEventListener("click", e => {
    const nav = document.getElementById("sidenav");
    nav.classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", nav.classList.contains("open"));
  });

  if (Api.hasToken()) startApp(); else showLogin("");
})();
