/**
 * COFFEE STOCK & DISTRIBUTION — SCREENS
 *
 * Hash-routed single page. Each route renders HTML from EstateStore and wires its own
 * form/button handlers. All business rules live in store.js; this file only collects
 * input, shows results and prints labels / dispatch notes.
 */
(() => {
  const S = EstateStore;
  S.load();

  const view = document.getElementById("view");
  const printRoot = document.getElementById("printRoot");

  /* ---------- formatting ---------- */

  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const kg = g => (g / 1000).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  const num = n => Number(n || 0).toLocaleString("en-IN");
  const fmtDate = d => d ? new Date(d.length === 10 ? d + "T00:00:00" : d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "";
  const fmtTime = d => d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const itemLabel = it => it ? `${it.name}` : "?";
  const itemMeta = it => it ? [it.coffeeType, it.form, it.grade && `Grade ${it.grade}`].filter(Boolean).join(" · ") : "";
  const lotLabel = l => l ? `${l.code} — ${itemLabel(S.item(l.itemId))}` : "?";
  const active = list => S.state[list].filter(r => r.active !== false).sort((a, b) => a.code.localeCompare(b.code));

  const STATUS_CLASS = { DRAFT: "amber", DISPATCHED: "green", POSTED: "green", PREPARED: "amber", CANCELLED: "grey", REVERSED: "red" };
  const badge = s => `<span class="badge ${STATUS_CLASS[s] || "grey"}">${esc(s)}</span>`;

  function toast(msg, kind = "ok") {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className = `toast show ${kind}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = "toast"; }, kind === "error" ? 6000 : 3000);
  }

  // Runs a store action; shows the business-rule message on failure instead of throwing.
  function attempt(fn, okMsg) {
    try {
      const r = fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.userFacing ? e.message : `Unexpected error: ${e.message}`, "error");
      if (!e.userFacing) console.error(e);
      return undefined;
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
    if (!active("godowns").length) missing.push(`<a href="#/masters/godowns">a godown</a>`);
    if (!active("items").length) missing.push(`<a href="#/masters/items">a coffee item</a>`);
    return missing.length ? `<div class="notice">Add ${missing.join(" and ")} first.</div>` : "";
  }

  // Lots with stock available in the given godown (for transfer / adjustment / dispatch pickers).
  function lotsIn(godownId, { includeEmpty = false } = {}) {
    return S.balances().filter(b => b.godownId === godownId && (includeEmpty || b.availableGrams > 0))
      .map(b => ({ ...b, lot: S.lot(b.lotId) }))
      .sort((a, b) => a.lot.code.localeCompare(b.lot.code));
  }

  const lotOption = (b, selected) =>
    `<option value="${esc(b.lotId)}" ${b.lotId === selected ? "selected" : ""}>${esc(b.lot.code)} — ${esc(itemLabel(S.item(b.lot.itemId)))} (${kg(b.availableGrams)} kg, ${num(b.availableBags)} bags free)</option>`;

  /* ---------- routes ---------- */

  const routes = [
    [/^\/?$/, dashboard, "dashboard"],
    [/^\/stock$/, stockView, "stock"],
    [/^\/lot\/(.+)$/, lotView, "stock"],
    [/^\/receive$/, receiveView, "receive"],
    [/^\/transfer$/, transferView, "transfer"],
    [/^\/adjust$/, adjustView, "adjust"],
    [/^\/ledger$/, ledgerView, "ledger"],
    [/^\/dispatches$/, dispatchList, "dispatches"],
    [/^\/dispatch\/new$/, () => dispatchForm(null), "dispatch-new"],
    [/^\/dispatch\/(.+)\/edit$/, id => dispatchForm(id), "dispatches"],
    [/^\/dispatch\/(.+)$/, dispatchDetail, "dispatches"],
    [/^\/track(?:\/(.+))?$/, trackView, "track"],
    [/^\/masters\/(godowns|items|clients)(?:\/(.+))?$/, mastersView, "masters"],
    [/^\/settings$/, settingsView, "settings"]
  ];

  function render() {
    const path = decodeURIComponent(location.hash.replace(/^#/, "")) || "/";
    document.getElementById("orgName").textContent = S.state.settings.organisation || "Coffee Stock";
    for (const [re, fn, nav] of routes) {
      const m = path.match(re);
      if (!m) continue;
      document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === nav));
      view.innerHTML = fn(...m.slice(1)) || "";
      const after = render.after; render.after = null;
      if (after) after();
      return;
    }
    view.innerHTML = `<div class="empty">Page not found. <a href="#/">Go to dashboard</a></div>`;
  }
  // Views register wiring that must run after their HTML is in the page.
  const then = fn => { render.after = fn; };

  window.addEventListener("hashchange", () => {
    render();
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    document.getElementById("sidenav").classList.remove("open");
  });

  /* ---------- dashboard ---------- */

  function dashboard() {
    const bal = S.balances();
    const totalG = bal.reduce((s, b) => s + b.onHandGrams, 0);
    const totalBags = bal.reduce((s, b) => s + b.onHandBags, 0);
    const reservedG = bal.reduce((s, b) => s + b.reservedGrams, 0);
    const drafts = S.state.dispatches.filter(d => d.status === "DRAFT");
    const month = S.today().slice(0, 7);
    const monthDisp = S.state.dispatches.filter(d => d.status === "DISPATCHED" && d.date.startsWith(month));
    const monthG = monthDisp.reduce((s, d) => s + d.lines.reduce((x, l) => x + l.grams, 0), 0);

    const byGodown = active("godowns").map(g => {
      const rows = bal.filter(b => b.godownId === g.id);
      return { g, grams: rows.reduce((s, b) => s + b.onHandGrams, 0), bags: rows.reduce((s, b) => s + b.onHandBags, 0), lots: rows.filter(b => b.onHandGrams > 0).length };
    });
    const byItem = new Map();
    for (const b of bal) {
      const cur = byItem.get(b.itemId) || { grams: 0, bags: 0 };
      cur.grams += b.onHandGrams; cur.bags += b.onHandBags;
      byItem.set(b.itemId, cur);
    }
    const recent = [...S.state.transactions].sort((a, b) => b.postedAt.localeCompare(a.postedAt)).slice(0, 8);
    const empty = !S.state.godowns.length && !S.state.items.length;

    return `
      <div class="page-head">
        <div><h1>Dashboard</h1><p class="sub">Coffee held in godowns and dispatched to clients.</p></div>
        <div class="actions">
          <a class="btn" href="#/receive">+ Receive stock</a>
          <a class="btn primary" href="#/dispatch/new">+ New dispatch</a>
        </div>
      </div>
      ${empty ? `<div class="notice">Nothing set up yet. Add your <a href="#/masters/godowns">godowns</a>, <a href="#/masters/items">coffee items</a> and <a href="#/masters/clients">clients</a>, or <a href="#/settings">load demo data</a> to explore.</div>` : ""}
      <div class="tiles">
        <div class="tile"><div class="tile-label">Stock on hand</div><div class="tile-value">${kg(totalG)} <small>kg</small></div><div class="tile-foot">${num(totalBags)} bags</div></div>
        <div class="tile"><div class="tile-label">Held by draft dispatches</div><div class="tile-value">${kg(reservedG)} <small>kg</small></div><div class="tile-foot">${drafts.length} draft${drafts.length === 1 ? "" : "s"}</div></div>
        <div class="tile"><div class="tile-label">Dispatched this month</div><div class="tile-value">${kg(monthG)} <small>kg</small></div><div class="tile-foot">${monthDisp.length} dispatch${monthDisp.length === 1 ? "" : "es"}</div></div>
        <div class="tile"><div class="tile-label">Active lots in stock</div><div class="tile-value">${new Set(bal.filter(b => b.onHandGrams > 0).map(b => b.lotId)).size}</div><div class="tile-foot">${active("godowns").length} godowns</div></div>
      </div>
      <div class="grid-2">
        <section class="card">
          <h2>By godown</h2>
          ${byGodown.length ? `<table class="tbl"><thead><tr><th>Godown</th><th class="r">kg</th><th class="r">Bags</th><th class="r">Lots</th></tr></thead><tbody>
            ${byGodown.map(r => `<tr><td><a href="#/stock?g=${esc(r.g.id)}">${esc(r.g.name)}</a></td><td class="r mono">${kg(r.grams)}</td><td class="r mono">${num(r.bags)}</td><td class="r">${r.lots}</td></tr>`).join("")}
          </tbody></table>` : `<div class="empty">No godowns yet.</div>`}
        </section>
        <section class="card">
          <h2>By coffee item</h2>
          ${byItem.size ? `<table class="tbl"><thead><tr><th>Item</th><th class="r">kg</th><th class="r">Bags</th></tr></thead><tbody>
            ${[...byItem].map(([id, v]) => { const it = S.item(id); return `<tr><td>${esc(itemLabel(it))}<div class="muted">${esc(itemMeta(it))}</div></td><td class="r mono">${kg(v.grams)}</td><td class="r mono">${num(v.bags)}</td></tr>`; }).join("")}
          </tbody></table>` : `<div class="empty">No stock yet.</div>`}
        </section>
      </div>
      ${drafts.length ? `<section class="card"><h2>Draft dispatches waiting to be posted</h2>${dispatchTable(drafts)}</section>` : ""}
      <section class="card">
        <h2>Recent activity</h2>
        ${recent.length ? txnTable(recent) : `<div class="empty">No stock movements yet.</div>`}
      </section>`;
  }

  /* ---------- stock ---------- */

  function query() { return new URLSearchParams(location.hash.split("?")[1] || ""); }

  function stockView() {
    const q = query();
    const gSel = q.get("g") || "", iSel = q.get("i") || "";
    const rows = S.balances()
      .filter(b => (!gSel || b.godownId === gSel) && (!iSel || b.itemId === iSel))
      .map(b => ({ ...b, g: S.godown(b.godownId), l: S.lot(b.lotId), it: S.item(b.itemId) }))
      .sort((a, b) => a.g.name.localeCompare(b.g.name) || a.l.code.localeCompare(b.l.code));
    const tot = rows.reduce((s, r) => ({ g: s.g + r.onHandGrams, b: s.b + r.onHandBags, rg: s.rg + r.reservedGrams, ag: s.ag + r.availableGrams, ab: s.ab + r.availableBags }), { g: 0, b: 0, rg: 0, ag: 0, ab: 0 });
    then(() => {
      document.getElementById("stockFilter").addEventListener("change", e => {
        const f = formData(e.currentTarget);
        location.hash = `#/stock?g=${encodeURIComponent(f.g)}&i=${encodeURIComponent(f.i)}`;
      });
      document.getElementById("exportStock").addEventListener("click", () => downloadCsv("stock-on-hand.csv",
        [["Godown", "Lot", "Item", "Type", "Form", "Grade", "On hand kg", "On hand bags", "Reserved kg", "Available kg", "Available bags"],
          ...rows.map(r => [r.g.name, r.l.code, r.it.name, r.it.coffeeType, r.it.form, r.it.grade, r.onHandGrams / 1000, r.onHandBags, r.reservedGrams / 1000, r.availableGrams / 1000, r.availableBags])]));
    });
    return `
      <div class="page-head">
        <div><h1>Stock on hand</h1><p class="sub">By godown and lot. Available = on hand minus quantities held by draft dispatches.</p></div>
        <div class="actions"><button class="btn" id="exportStock">Export CSV</button></div>
      </div>
      <form class="filters" id="stockFilter">
        <label>Godown<select name="g">${options(S.state.godowns, gSel, g => g.name, "All godowns")}</select></label>
        <label>Item<select name="i">${options(S.state.items, iSel, itemLabel, "All items")}</select></label>
      </form>
      <section class="card flush">
        ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Godown</th><th>Lot</th><th>Item</th><th class="r">On hand kg</th><th class="r">Bags</th><th class="r">Reserved kg</th><th class="r">Available kg</th><th class="r">Avail. bags</th></tr></thead><tbody>
          ${rows.map(r => `<tr><td>${esc(r.g.name)}</td><td><a class="mono" href="#/lot/${esc(r.lotId)}">${esc(r.l.code)}</a></td><td>${esc(r.it.name)}<div class="muted">${esc(itemMeta(r.it))}</div></td>
            <td class="r mono">${kg(r.onHandGrams)}</td><td class="r mono">${num(r.onHandBags)}</td><td class="r mono">${r.reservedGrams ? kg(r.reservedGrams) : "–"}</td><td class="r mono strong">${kg(r.availableGrams)}</td><td class="r mono">${num(r.availableBags)}</td></tr>`).join("")}
          </tbody><tfoot><tr><td colspan="3">Total</td><td class="r mono">${kg(tot.g)}</td><td class="r mono">${num(tot.b)}</td><td class="r mono">${kg(tot.rg)}</td><td class="r mono">${kg(tot.ag)}</td><td class="r mono">${num(tot.ab)}</td></tr></tfoot></table></div>`
          : `<div class="empty">No stock matches. ${setupNeeded() || `<a href="#/receive">Receive stock</a>`}</div>`}
      </section>`;
  }

  function lotView(lotId) {
    const l = S.lot(lotId);
    if (!l) return `<div class="empty">Lot not found.</div>`;
    const it = S.item(l.itemId);
    const entries = S.state.ledger.filter(e => e.lotId === l.id).sort((a, b) => a.at.localeCompare(b.at));
    let runG = 0, runB = 0;
    const rows = entries.map(e => { runG += e.grams; runB += e.bags; return { e, t: S.transaction(e.txnId), runG, runB }; });
    const packages = S.state.packages.filter(p => p.lotId === l.id && p.status === "DISPATCHED");
    return `
      <div class="page-head"><div><div class="crumb"><a href="#/stock">Stock</a> / Lot</div><h1 class="mono">${esc(l.code)}</h1><p class="sub">${esc(it.name)} · ${esc(itemMeta(it))}</p></div></div>
      <section class="card">
        <dl class="facts">
          <div><dt>Source</dt><dd>${esc(l.sourceType)}${l.sourceRef ? ` · ${esc(l.sourceRef)}` : ""}</dd></div>
          <div><dt>Crop year</dt><dd>${esc(l.cropYear || "–")}</dd></div>
          <div><dt>Moisture at receipt</dt><dd>${l.moisturePct != null ? esc(l.moisturePct) + " %" : "–"}</dd></div>
          <div><dt>Outturn</dt><dd>${l.outturnPct != null ? esc(l.outturnPct) + " %" : "–"}</dd></div>
          <div><dt>Packages dispatched</dt><dd>${packages.length}</dd></div>
          <div><dt>Created</dt><dd>${fmtDate(l.createdAt)}</dd></div>
        </dl>
        ${l.notes ? `<p class="muted">${esc(l.notes)}</p>` : ""}
      </section>
      <section class="card flush"><h2 class="pad">Movement history</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Txn</th><th>Type</th><th>Godown</th><th class="r">kg</th><th class="r">Bags</th><th class="r">Lot balance kg</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${fmtDate(r.e.date)}</td><td class="mono">${r.t.dispatchId ? `<a href="#/dispatch/${esc(r.t.dispatchId)}">${esc(r.t.no)}</a>` : esc(r.t.no)}</td><td>${esc(r.t.type)}</td><td>${esc(S.godown(r.e.godownId).name)}</td>
          <td class="r mono ${r.e.grams < 0 ? "neg" : "pos"}">${r.e.grams > 0 ? "+" : ""}${kg(r.e.grams)}</td><td class="r mono">${r.e.bags > 0 ? "+" : ""}${num(r.e.bags)}</td><td class="r mono">${kg(r.runG)}</td></tr>`).join("")}
        </tbody></table></div>
      </section>`;
  }

  /* ---------- receive / transfer / adjust ---------- */

  function receiveView() {
    const lots = S.state.lots.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    then(() => {
      const f = document.getElementById("receiveForm");
      const sync = () => {
        const isNew = f.lotMode.value === "new";
        f.querySelectorAll("[data-newlot]").forEach(el => el.hidden = !isNew);
        f.querySelector("[data-oldlot]").hidden = isNew;
        // Only offer existing lots of the chosen item.
        const itemId = f.itemId.value;
        f.lotId.innerHTML = options(lots.filter(l => l.itemId === itemId), "", l => l.code, itemId ? "Select lot" : "Select an item first");
      };
      f.addEventListener("change", e => { if (e.target.name === "lotMode" || e.target.name === "itemId") sync(); });
      f.addEventListener("input", e => {
        if (e.target.name === "bags" && !f.kg.dataset.touched) {
          const it = S.item(f.itemId.value);
          if (it && it.bagKg) f.kg.value = Number(e.target.value || 0) * it.bagKg || "";
        }
        if (e.target.name === "kg") f.kg.dataset.touched = "1";
      });
      sync();
      f.addEventListener("submit", e => {
        e.preventDefault();
        const d = formData(f);
        if (d.lotMode === "new") delete d.lotId;
        else if (!d.lotId) return toast("Pick the existing lot to add to.", "error");
        else ["lotCode", "cropYear", "moisturePct", "outturnPct", "sourceRef"].forEach(k => delete d[k]);
        d.opening = d.opening === "on";
        const t = attempt(() => S.receive(d), "Stock received");
        if (t) { f.reset(); delete f.kg.dataset.touched; f.date.value = S.today(); sync(); showPosted(t); }
      });
    });
    return `
      <div class="page-head"><div><h1>Receive stock</h1><p class="sub">Coffee arriving at a godown. Each receipt adds to a lot — new or existing.</p></div></div>
      ${setupNeeded()}
      <div id="postedNote"></div>
      <form class="card form" id="receiveForm">
        <div class="form-grid">
          <label>Date<input type="date" name="date" value="${S.today()}" required></label>
          <label>Godown<select name="godownId" required>${options(active("godowns"), "", g => g.name, "Select godown")}</select></label>
          <label class="span-2">Coffee item<select name="itemId" required>${options(active("items"), "", it => `${it.name} (${it.code})`, "Select item")}</select></label>
          <fieldset class="span-2 seg"><legend>Lot</legend>
            <label><input type="radio" name="lotMode" value="new" checked> New lot</label>
            <label><input type="radio" name="lotMode" value="existing"> Add to existing lot</label>
          </fieldset>
          <label data-newlot>Lot code<input name="lotCode" placeholder="Auto: LOT-${S.today().slice(0, 4)}-00001" maxlength="40"></label>
          <label data-newlot>Crop year<input name="cropYear" placeholder="e.g. 2025-26" maxlength="20"></label>
          <label data-newlot>Moisture %<input type="number" name="moisturePct" step="0.1" min="0" max="100"></label>
          <label data-newlot>Outturn %<input type="number" name="outturnPct" step="0.1" min="0" max="100"></label>
          <label data-newlot class="span-2">Source / estate reference<input name="sourceRef" placeholder="Estate, block, supplier or delivery reference" maxlength="120"></label>
          <label data-oldlot class="span-2" hidden>Existing lot<select name="lotId"></select></label>
          <label>Bags<input type="number" name="bags" min="0" step="1" required></label>
          <label>Net weight (kg)<input type="number" name="kg" min="0.001" step="0.001" required></label>
          <label class="span-2">Reference (weighbridge slip, delivery note)<input name="reference" maxlength="80"></label>
          <label class="span-2">Notes<textarea name="notes" rows="2"></textarea></label>
          <label class="check span-2"><input type="checkbox" name="opening"> Opening balance (stock already in the godown at go-live)</label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Post receipt</button></div>
      </form>`;
  }

  function showPosted(t) {
    const el = document.getElementById("postedNote");
    if (el) el.innerHTML = `<div class="notice ok">Posted <strong class="mono">${esc(t.no)}</strong>. <a href="#/stock">View stock</a></div>`;
  }

  function lotPickerWiring(formId, godownField) {
    const f = document.getElementById(formId);
    const sync = () => { f.lotId.innerHTML = `<option value="">Select lot</option>` + lotsIn(f[godownField].value, { includeEmpty: formId === "adjustForm" }).map(b => lotOption(b)).join(""); };
    f[godownField].addEventListener("change", sync);
    sync();
    return { f, sync };
  }

  function transferView() {
    then(() => {
      const { f, sync } = lotPickerWiring("transferForm", "fromGodownId");
      f.addEventListener("submit", e => {
        e.preventDefault();
        const t = attempt(() => S.transfer(formData(f)), "Transfer posted");
        if (t) { f.reset(); f.date.value = S.today(); sync(); showPosted(t); }
      });
    });
    return `
      <div class="page-head"><div><h1>Transfer between godowns</h1><p class="sub">Moves a lot from one godown to another in a single posting.</p></div></div>
      ${setupNeeded()}
      <div id="postedNote"></div>
      <form class="card form" id="transferForm">
        <div class="form-grid">
          <label>Date<input type="date" name="date" value="${S.today()}" required></label>
          <label>Reference<input name="reference" maxlength="80" placeholder="Vehicle / gate pass"></label>
          <label>From godown<select name="fromGodownId" required>${options(active("godowns"), "", g => g.name, "Select")}</select></label>
          <label>To godown<select name="toGodownId" required>${options(active("godowns"), "", g => g.name, "Select")}</select></label>
          <label class="span-2">Lot<select name="lotId" required></select></label>
          <label>Bags<input type="number" name="bags" min="0" step="1" required></label>
          <label>Net weight (kg)<input type="number" name="kg" min="0.001" step="0.001" required></label>
          <label class="span-2">Notes<textarea name="notes" rows="2"></textarea></label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Post transfer</button></div>
      </form>`;
  }

  function adjustView() {
    then(() => {
      const { f, sync } = lotPickerWiring("adjustForm", "godownId");
      f.addEventListener("submit", e => {
        e.preventDefault();
        const t = attempt(() => S.adjust(formData(f)), "Adjustment posted");
        if (t) { f.reset(); f.date.value = S.today(); sync(); showPosted(t); }
      });
    });
    return `
      <div class="page-head"><div><h1>Stock adjustment</h1><p class="sub">Corrections for weight loss, sampling, damage or count differences. A reason is always recorded.</p></div></div>
      ${setupNeeded()}
      <div id="postedNote"></div>
      <form class="card form" id="adjustForm">
        <div class="form-grid">
          <label>Date<input type="date" name="date" value="${S.today()}" required></label>
          <label>Godown<select name="godownId" required>${options(active("godowns"), "", g => g.name, "Select")}</select></label>
          <label class="span-2">Lot<select name="lotId" required></select></label>
          <fieldset class="span-2 seg"><legend>Direction</legend>
            <label><input type="radio" name="direction" value="OUT" checked> Decrease (loss)</label>
            <label><input type="radio" name="direction" value="IN"> Increase (gain)</label>
          </fieldset>
          <label>Bags<input type="number" name="bags" min="0" step="1" value="0"></label>
          <label>Weight (kg)<input type="number" name="kg" min="0" step="0.001" value="0"></label>
          <label class="span-2">Reason<select name="reason" required>${plainOptions(S.ADJUSTMENT_REASONS, "", "Select reason")}</select></label>
          <label class="span-2">Reference<input name="reference" maxlength="80"></label>
          <label class="span-2">Notes<textarea name="notes" rows="2"></textarea></label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Post adjustment</button></div>
      </form>`;
  }

  /* ---------- ledger ---------- */

  function txnTable(list, { withActions = false } = {}) {
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Details</th><th class="r">kg</th><th>Status</th>${withActions ? "<th></th>" : ""}</tr></thead><tbody>
      ${list.map(t => {
        const entries = S.state.ledger.filter(e => e.txnId === t.id);
        const net = entries.reduce((s, e) => s + e.grams, 0);
        const moved = t.type === "TRANSFER" ? entries.filter(e => e.grams > 0).reduce((s, e) => s + e.grams, 0) : net;
        const lots = [...new Set(entries.map(e => S.lot(e.lotId).code))].join(", ");
        const where = t.type === "TRANSFER"
          ? `${esc(S.godown(entries.find(e => e.grams < 0).godownId).name)} → ${esc(S.godown(entries.find(e => e.grams > 0).godownId).name)}`
          : [...new Set(entries.map(e => S.godown(e.godownId).name))].map(esc).join(", ");
        const canReverse = withActions && t.status === "POSTED" && t.type !== "REVERSAL" && t.type !== "DISPATCH";
        return `<tr><td class="mono">${t.dispatchId ? `<a href="#/dispatch/${esc(t.dispatchId)}">${esc(t.no)}</a>` : esc(t.no)}</td><td>${fmtDate(t.date)}</td><td>${esc(t.type)}</td>
          <td>${where} · <span class="mono">${esc(lots)}</span>${t.reason ? `<div class="muted">${esc(t.reason)}</div>` : ""}${t.reference ? `<div class="muted">Ref: ${esc(t.reference)}</div>` : ""}</td>
          <td class="r mono ${t.type === "TRANSFER" ? "" : moved < 0 ? "neg" : "pos"}">${t.type === "TRANSFER" ? "" : moved > 0 ? "+" : ""}${kg(moved)}</td><td>${badge(t.status)}</td>
          ${withActions ? `<td>${canReverse ? `<button class="btn small ghost" data-reverse="${esc(t.id)}">Reverse</button>` : ""}</td>` : ""}</tr>`;
      }).join("")}
    </tbody></table></div>`;
  }

  function ledgerView() {
    const q = query();
    const type = q.get("t") || "";
    const list = S.state.transactions.filter(t => !type || t.type === type).sort((a, b) => b.postedAt.localeCompare(a.postedAt));
    then(() => {
      document.getElementById("ledgerFilter").addEventListener("change", e => { location.hash = `#/ledger?t=${encodeURIComponent(e.target.value)}`; });
      document.getElementById("ledgerList").addEventListener("click", e => {
        const id = e.target.dataset && e.target.dataset.reverse;
        if (!id) return;
        const t = S.transaction(id);
        const reason = prompt(`Reverse ${t.no}? This posts an opposite movement. Enter a reason:`);
        if (reason == null) return;
        if (attempt(() => S.reverseTransaction(id, reason), `${t.no} reversed`)) render();
      });
      document.getElementById("exportLedger").addEventListener("click", () => downloadCsv("stock-ledger.csv",
        [["Txn no", "Type", "Status", "Date", "Godown", "Lot", "Item", "kg", "Bags", "Reference", "Reason", "Posted at", "Posted by"],
          ...S.state.ledger.map(e => { const t = S.transaction(e.txnId); return [t.no, t.type, t.status, e.date, S.godown(e.godownId).name, S.lot(e.lotId).code, S.item(e.itemId).name, e.grams / 1000, e.bags, t.reference, t.reason, t.postedAt, t.postedBy]; })]));
    });
    return `
      <div class="page-head"><div><h1>Stock ledger</h1><p class="sub">Every posted movement. Posted records are never edited — mistakes are reversed with an opposite entry.</p></div>
        <div class="actions"><button class="btn" id="exportLedger">Export CSV</button></div></div>
      <form class="filters"><label>Type<select id="ledgerFilter">${plainOptions(S.TXN_TYPES, type, "All types")}</select></label></form>
      <section class="card flush" id="ledgerList">${list.length ? txnTable(list, { withActions: true }) : `<div class="empty">No transactions yet.</div>`}</section>`;
  }

  /* ---------- dispatch ---------- */

  function dispatchTotals(d) {
    return d.lines.reduce((s, l) => ({ grams: s.grams + l.grams, bags: s.bags + l.bags }), { grams: 0, bags: 0 });
  }

  function dispatchTable(list) {
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Dispatch</th><th>Date</th><th>Client</th><th>Vehicle</th><th class="r">kg</th><th class="r">Bags</th><th class="r">Pkgs</th><th>Status</th></tr></thead><tbody>
      ${list.map(d => { const t = dispatchTotals(d); return `<tr><td class="mono"><a href="#/dispatch/${esc(d.id)}">${esc(d.no)}</a></td><td>${fmtDate(d.date)}</td><td>${esc(S.client(d.clientId).name)}</td><td class="mono">${esc(d.vehicleNo || "–")}</td>
        <td class="r mono">${kg(t.grams)}</td><td class="r mono">${num(t.bags)}</td><td class="r">${S.activePackages(d.id).length || "–"}</td><td>${badge(d.status)}</td></tr>`; }).join("")}
    </tbody></table></div>`;
  }

  function dispatchList() {
    const q = query();
    const st = q.get("s") || "";
    const list = S.state.dispatches.filter(d => !st || d.status === st).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    then(() => {
      document.getElementById("dispFilter").addEventListener("change", e => { location.hash = `#/dispatches?s=${encodeURIComponent(e.target.value)}`; });
      document.getElementById("exportDisp").addEventListener("click", () => downloadCsv("dispatch-register.csv",
        [["Dispatch no", "Date", "Status", "Client", "Destination", "Vehicle", "Driver", "Godown", "Lot", "Item", "kg", "Bags", "Packages"],
          ...S.state.dispatches.flatMap(d => d.lines.map(l => [d.no, d.date, d.status, S.client(d.clientId).name, d.destination, d.vehicleNo, d.driverName, S.godown(l.godownId).name, S.lot(l.lotId).code, S.item(l.itemId).name, l.grams / 1000, l.bags, l.packages]))]));
    });
    return `
      <div class="page-head"><div><h1>Dispatches</h1><p class="sub">Coffee sent to clients. Each package carries its own barcode.</p></div>
        <div class="actions"><button class="btn" id="exportDisp">Export CSV</button><a class="btn primary" href="#/dispatch/new">+ New dispatch</a></div></div>
      <form class="filters"><label>Status<select id="dispFilter">${plainOptions(["DRAFT", "DISPATCHED", "CANCELLED", "REVERSED"], st, "All")}</select></label></form>
      <section class="card flush">${list.length ? dispatchTable(list) : `<div class="empty">No dispatches yet. <a href="#/dispatch/new">Create one</a>.</div>`}</section>`;
  }

  function dispatchForm(id) {
    const d = id ? S.dispatch(id) : null;
    if (id && (!d || d.status !== "DRAFT")) return `<div class="empty">Only draft dispatches can be edited. <a href="#/dispatches">Back</a></div>`;
    const clients = active("clients");
    const godowns = active("godowns");
    const lineHtml = (l = {}) => `
      <div class="line" data-line>
        <label>Godown<select name="godownId" required>${options(godowns, l.godownId, g => g.name, "Select")}</select></label>
        <label class="grow">Lot<select name="lotId" required data-selected="${esc(l.lotId || "")}"></select></label>
        <label>Bags<input type="number" name="bags" min="0" step="1" value="${l.bags != null ? l.bags : ""}" required></label>
        <label>Net kg<input type="number" name="kg" min="0.001" step="0.001" value="${l.grams != null ? l.grams / 1000 : ""}" required></label>
        <label title="Number of barcode labels for this line. Normally one per bag.">Packages<input type="number" name="packages" min="1" step="1" value="${l.packages || ""}" placeholder="= bags"></label>
        <button type="button" class="btn small ghost" data-remove aria-label="Remove line">✕</button>
      </div>`;
    then(() => {
      const f = document.getElementById("dispatchForm");
      const lines = document.getElementById("lines");
      const fillLots = row => {
        const sel = row.querySelector("[name=lotId]");
        const gid = row.querySelector("[name=godownId]").value;
        const keep = sel.value || sel.dataset.selected;
        // While editing a draft, its own reservation counts as available.
        const rows = gid ? S.balances().filter(b => b.godownId === gid).map(b => {
          const a = S.available(gid, b.lotId, d ? d.id : null);
          return { ...b, availableGrams: a.grams, availableBags: a.bags, lot: S.lot(b.lotId) };
        }).filter(b => b.availableGrams > 0 || b.lotId === keep) : [];
        sel.innerHTML = `<option value="">${gid ? (rows.length ? "Select lot" : "No stock in this godown") : "Select godown first"}</option>` + rows.map(b => lotOption(b, keep)).join("");
      };
      lines.querySelectorAll("[data-line]").forEach(fillLots);
      lines.addEventListener("change", e => {
        const row = e.target.closest("[data-line]");
        if (e.target.name === "godownId") fillLots(row);
      });
      lines.addEventListener("input", e => {
        const row = e.target.closest("[data-line]");
        if (e.target.name === "bags") {
          const lt = S.lot(row.querySelector("[name=lotId]").value);
          const it = lt && S.item(lt.itemId);
          const kgEl = row.querySelector("[name=kg]");
          if (it && it.bagKg && !kgEl.dataset.touched) kgEl.value = Number(e.target.value || 0) * it.bagKg || "";
        }
        if (e.target.name === "kg") e.target.dataset.touched = "1";
      });
      lines.addEventListener("click", e => {
        if (e.target.matches("[data-remove]") && lines.children.length > 1) e.target.closest("[data-line]").remove();
      });
      document.getElementById("addLine").addEventListener("click", () => {
        lines.insertAdjacentHTML("beforeend", lineHtml());
        fillLots(lines.lastElementChild);
      });
      f.clientId.addEventListener("change", () => {
        const c = S.client(f.clientId.value);
        if (c && !f.destination.value) f.destination.value = c.address;
      });
      f.addEventListener("submit", e => {
        e.preventDefault();
        const data = formData(f);
        data.id = d ? d.id : null;
        data.lines = [...lines.querySelectorAll("[data-line]")].map((row, i) => ({
          id: d && d.lines[i] ? d.lines[i].id : undefined,
          godownId: row.querySelector("[name=godownId]").value,
          lotId: row.querySelector("[name=lotId]").value,
          bags: row.querySelector("[name=bags]").value,
          kg: row.querySelector("[name=kg]").value,
          packages: row.querySelector("[name=packages]").value
        }));
        const saved = attempt(() => S.saveDispatchDraft(data), d ? "Draft updated" : "Draft saved — barcodes issued");
        if (saved) location.hash = `#/dispatch/${saved.id}`;
      });
    });
    return `
      <div class="page-head"><div><div class="crumb"><a href="#/dispatches">Dispatches</a> / ${d ? esc(d.no) : "New"}</div>
        <h1>${d ? "Edit draft dispatch" : "New dispatch"}</h1><p class="sub">Saving the draft holds the stock and issues one barcode per package. Post it when the truck leaves.</p></div></div>
      ${setupNeeded()}${!clients.length ? `<div class="notice">Add a <a href="#/masters/clients">client</a> first.</div>` : ""}
      ${d && S.activePackages(d.id).some(p => p.printCount) ? `<div class="notice">Labels for this draft were already printed. Changing godown, lot, bags, kg or package count will retire those barcodes and issue new ones — reprint and replace the labels.</div>` : ""}
      <form class="card form" id="dispatchForm">
        <h2>Consignee &amp; transport</h2>
        <div class="form-grid">
          <label class="span-2">Client<select name="clientId" required>${options(clients, d && d.clientId, c => `${c.name} (${c.code})`, "Select client")}</select></label>
          <label>Dispatch date<input type="date" name="date" value="${esc(d ? d.date : S.today())}" required></label>
          <label>Client order / reference<input name="reference" value="${esc(d ? d.reference : "")}" maxlength="80"></label>
          <label class="span-2">Delivery address / destination<textarea name="destination" rows="2">${esc(d ? d.destination : "")}</textarea></label>
          <label>Vehicle no.<input name="vehicleNo" value="${esc(d ? d.vehicleNo : "")}" maxlength="20" placeholder="KA 12 AB 3456"></label>
          <label>Transporter<input name="transporter" value="${esc(d ? d.transporter : "")}" maxlength="80"></label>
          <label>Driver name<input name="driverName" value="${esc(d ? d.driverName : "")}" maxlength="60"></label>
          <label>Driver phone<input name="driverPhone" value="${esc(d ? d.driverPhone : "")}" maxlength="20" inputmode="tel"></label>
          <label class="span-2">Notes<textarea name="notes" rows="2">${esc(d ? d.notes : "")}</textarea></label>
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

  function dispatchDetail(id) {
    const d = S.dispatch(id);
    if (!d) return `<div class="empty">Dispatch not found. <a href="#/dispatches">Back</a></div>`;
    const c = S.client(d.clientId);
    const pk = d.status === "DRAFT" || d.status === "DISPATCHED" ? S.activePackages(d.id)
      : S.state.packages.filter(p => p.dispatchId === d.id && p.cancelledAt === (d.cancelledAt || d.reversedAt)).sort((a, b) => a.seq - b.seq);
    const rec = S.reconciliation(d);
    const tot = dispatchTotals(d);
    const draft = d.status === "DRAFT";
    then(() => {
      view.querySelector(".page-actions").addEventListener("click", e => {
        const act = e.target.dataset.act;
        if (!act) return;
        if (act === "post") {
          if (!confirm(`Post ${d.no}? Stock will be deducted and the ${pk.length} package barcodes become final.`)) return;
          if (attempt(() => S.postDispatch(d.id), `${d.no} dispatched`)) render();
        } else if (act === "cancel") {
          const r = prompt(`Cancel draft ${d.no}? Held stock is released and its barcodes retired. Reason (optional):`);
          if (r == null) return;
          if (attempt(() => S.cancelDispatchDraft(d.id, r), "Draft cancelled")) render();
        } else if (act === "reverse") {
          const r = prompt(`Reverse ${d.no}? Use this only if the goods did NOT leave. Stock returns to the godown and barcodes are retired. Reason:`);
          if (r == null) return;
          if (attempt(() => S.reverseDispatch(d.id, r), `${d.no} reversed`)) render();
        } else if (act === "labels") printLabels(d, pk);
        else if (act === "note") printDispatchNote(d);
      });
      const wf = document.getElementById("weightsForm");
      if (wf) wf.addEventListener("submit", e => {
        e.preventDefault();
        const weights = {};
        wf.querySelectorAll("[data-pkg]").forEach(inp => {
          const p = pk.find(x => x.id === inp.dataset.pkg);
          if (S.toGrams(inp.value) !== p.grams) weights[p.id] = inp.value;
        });
        if (!Object.keys(weights).length) return toast("No weights changed.");
        if (attempt(() => S.setPackageWeights(d.id, weights), "Package weights saved")) render();
      });
      view.querySelectorAll("[data-print-one]").forEach(b => b.addEventListener("click", () => printLabels(d, [pk.find(p => p.id === b.dataset.printOne)])));
    });
    return `
      <div class="page-head">
        <div><div class="crumb"><a href="#/dispatches">Dispatches</a> / ${esc(d.no)}</div>
          <h1 class="mono">${esc(d.no)} ${badge(d.status)}</h1>
          <p class="sub">${esc(c.name)} · ${fmtDate(d.date)} · ${kg(tot.grams)} kg · ${num(tot.bags)} bags · ${pk.length} packages</p></div>
        <div class="actions page-actions">
          ${pk.length ? `<button class="btn" data-act="labels">Print labels (${pk.length})</button>` : ""}
          <button class="btn" data-act="note">Print dispatch note</button>
          ${draft ? `<a class="btn" href="#/dispatch/${esc(d.id)}/edit">Edit</a><button class="btn danger ghost" data-act="cancel">Cancel draft</button><button class="btn primary" data-act="post">Post dispatch</button>` : ""}
          ${d.status === "DISPATCHED" ? `<button class="btn danger ghost" data-act="reverse">Reverse</button>` : ""}
        </div>
      </div>
      ${draft ? `<div class="notice">Draft: stock is held for this dispatch but not yet deducted. Print and stick the labels, check weights, then <strong>Post dispatch</strong> when the vehicle leaves.</div>` : ""}
      ${d.status === "REVERSED" ? `<div class="notice warn">Reversed: ${esc(d.reverseReason)}. Stock was returned to the godown; barcodes are retired.</div>` : ""}
      ${d.status === "CANCELLED" ? `<div class="notice warn">Cancelled draft${d.cancelReason ? `: ${esc(d.cancelReason)}` : ""}. Barcodes are retired.</div>` : ""}
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
            ${d.postedAt ? `<div><dt>Posted</dt><dd>${fmtTime(d.postedAt)}${d.postedBy ? ` by ${esc(d.postedBy)}` : ""}</dd></div>` : ""}
            ${d.notes ? `<div><dt>Notes</dt><dd class="pre">${esc(d.notes)}</dd></div>` : ""}
          </dl></section>
      </div>
      <section class="card flush"><h2 class="pad">Lines</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Godown</th><th>Lot</th><th>Item</th><th class="r">Bags</th><th class="r">Net kg</th><th class="r">Packages</th>${draft ? "<th>Packages add up?</th>" : ""}</tr></thead><tbody>
        ${d.lines.map((l, i) => { const r = rec[i]; return `<tr><td>${i + 1}</td><td>${esc(S.godown(l.godownId).name)}</td><td class="mono"><a href="#/lot/${esc(l.lotId)}">${esc(S.lot(l.lotId).code)}</a></td><td>${esc(S.item(l.itemId).name)}</td>
          <td class="r mono">${num(l.bags)}</td><td class="r mono">${kg(l.grams)}</td><td class="r">${l.packages}</td>
          ${draft ? `<td>${r.ok ? `<span class="badge green">Yes</span>` : `<span class="badge red">Packages ${kg(r.packageGrams)} kg / ${r.packageBags} bags</span>`}</td>` : ""}</tr>`; }).join("")}
        </tbody></table></div>
      </section>
      <section class="card flush"><h2 class="pad">Packages &amp; barcodes</h2>
        <form id="weightsForm">
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Package</th><th>Barcode</th><th>Lot</th><th class="r">Bags</th><th class="r">Net kg</th><th>Status</th><th class="r">Printed</th><th></th></tr></thead><tbody>
        ${pk.map(p => `<tr><td class="mono">${p.seq} of ${pk.length}</td><td><a class="mono" href="#/track/${esc(p.barcode)}">${esc(p.barcode)}</a></td><td class="mono">${esc(S.lot(p.lotId).code)}</td><td class="r mono">${p.bags}</td>
          <td class="r">${draft ? `<input class="wt" type="number" min="0.001" step="0.001" value="${p.grams / 1000}" data-pkg="${esc(p.id)}" aria-label="Net kg for package ${p.seq}">` : `<span class="mono">${kg(p.grams)}</span>`}</td>
          <td>${badge(p.status)}</td><td class="r">${p.printCount || 0}×</td><td><button type="button" class="btn small ghost" data-print-one="${esc(p.id)}">Label</button></td></tr>`).join("")}
        </tbody></table></div>
        ${draft ? `<div class="form-actions pad"><span class="muted">Weighed each bag? Enter actual net kg per package; totals must match the line before posting.</span><button class="btn" type="submit">Save weights</button></div>` : ""}
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
    const c = S.client(d.clientId);
    const l = S.lot(p.lotId);
    const it = S.item(l.itemId);
    const org = S.state.settings.organisation;
    return `<div class="label">
      <div class="lb-top"><span class="lb-org">${esc(org)}</span><span class="lb-pkg">PKG ${p.seq} / ${count}</span></div>
      <div class="lb-to"><span class="lb-k">TO</span> <strong>${esc(c.name)}</strong><div class="lb-addr">${esc((d.destination || "").split("\n")[0])}</div></div>
      <div class="lb-grid">
        <div><span class="lb-k">Dispatch</span><b>${esc(d.no)}</b></div>
        <div><span class="lb-k">Date</span><b>${fmtDate(d.date)}</b></div>
        <div><span class="lb-k">Vehicle</span><b>${esc(d.vehicleNo || "–")}</b></div>
        <div class="span-3"><span class="lb-k">Coffee</span><b>${esc(it.name)}</b> ${esc(itemMeta(it))}</div>
        <div><span class="lb-k">Lot</span><b>${esc(l.code)}</b></div>
        <div><span class="lb-k">Net wt</span><b>${kg(p.grams)} kg</b></div>
        <div><span class="lb-k">Bags</span><b>${p.bags}</b></div>
      </div>
      <div class="lb-code">${Code128.svg(p.barcode, { moduleWidth: 2, height: 50 })}</div>
      <div class="lb-value">${esc(p.barcode)}</div>
    </div>`;
  }

  function printLabels(d, pk) {
    if (!pk.length) return;
    const all = S.activePackages(d.id).length || pk.length;
    const { labelWidthMm: w, labelHeightMm: h } = S.state.settings;
    S.markPrinted(pk.map(p => p.id));
    printNow(`<div class="labels" style="--lw:${Number(w)}mm;--lh:${Number(h)}mm">${pk.map(p => labelHtml(d, p, all)).join("")}</div>`, `size: ${Number(w)}mm ${Number(h)}mm; margin: 0;`);
    setTimeout(render, 500);
  }

  function printDispatchNote(d) {
    const c = S.client(d.clientId);
    const pk = d.status === "DRAFT" || d.status === "DISPATCHED" ? S.activePackages(d.id) : [];
    const tot = dispatchTotals(d);
    const org = S.state.settings;
    const html = `<div class="note">
      <header class="nt-head"><div><div class="nt-org">${esc(org.organisation)}</div><div class="nt-sub">${esc(org.orgAddress || "")}</div></div>
        <div class="nt-title">DISPATCH NOTE${d.status === "DRAFT" ? " <span>(DRAFT — not yet posted)</span>" : ""}${d.status === "REVERSED" || d.status === "CANCELLED" ? ` <span>(${esc(d.status)})</span>` : ""}</div></header>
      <div class="nt-meta">
        <div><span>Dispatch no.</span><b>${esc(d.no)}</b></div><div><span>Date</span><b>${fmtDate(d.date)}</b></div>
        <div><span>Vehicle no.</span><b>${esc(d.vehicleNo || "")}</b></div><div><span>Transporter</span><b>${esc(d.transporter || "")}</b></div>
        <div><span>Driver</span><b>${esc([d.driverName, d.driverPhone].filter(Boolean).join(" · "))}</b></div><div><span>Client ref.</span><b>${esc(d.reference || "")}</b></div>
      </div>
      <div class="nt-to"><span>Consignee</span><b>${esc(c.name)}</b>${c.gstin ? ` · GSTIN ${esc(c.gstin)}` : ""}<div class="pre">${esc(d.destination || c.address || "")}</div></div>
      <table class="nt-tbl"><thead><tr><th>#</th><th>Coffee</th><th>Lot</th><th>From godown</th><th class="r">Bags</th><th class="r">Net kg</th></tr></thead><tbody>
        ${d.lines.map((l, i) => { const it = S.item(l.itemId); return `<tr><td>${i + 1}</td><td>${esc(it.name)}<div class="muted">${esc(itemMeta(it))}</div></td><td>${esc(S.lot(l.lotId).code)}</td><td>${esc(S.godown(l.godownId).name)}</td><td class="r">${num(l.bags)}</td><td class="r">${kg(l.grams)}</td></tr>`; }).join("")}
      </tbody><tfoot><tr><td colspan="4">Total</td><td class="r">${num(tot.bags)}</td><td class="r">${kg(tot.grams)}</td></tr></tfoot></table>
      ${pk.length ? `<h3>Packages (${pk.length}) — scan any label to trace</h3>
      <div class="nt-pkgs">${pk.map(p => `<div class="nt-pkg"><div class="nt-pkg-code">${Code128.svg(p.barcode, { moduleWidth: 1, height: 26 })}</div><div><b>${p.seq}/${pk.length}</b> ${esc(p.barcode)}<br>${esc(S.lot(p.lotId).code)} · ${kg(p.grams)} kg · ${p.bags} bag${p.bags === 1 ? "" : "s"}</div></div>`).join("")}</div>` : ""}
      ${d.notes ? `<p><b>Notes:</b> ${esc(d.notes)}</p>` : ""}
      <div class="nt-sign"><div>Prepared by</div><div>Checked by (godown)</div><div>Driver</div><div>Received by (consignee)</div></div>
    </div>`;
    printNow(html, "size: A4; margin: 12mm;");
  }

  /* ---------- track ---------- */

  function trackView(code) {
    const t = code ? S.trace(code) : null;
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
        ...t.receipts.map(r => ({ at: r.postedAt, text: `${r.type === "OPENING" ? "Opening stock" : "Received"} into ${S.godown(S.state.ledger.find(e => e.txnId === r.id && e.lotId === t.lot.id).godownId).name}`, ref: r.no })),
        { at: p.createdAt, text: "Package created, barcode issued", ref: d.no },
        ...(p.dispatchedAt ? [{ at: p.dispatchedAt, text: `Dispatched to ${t.client.name}${d.vehicleNo ? ` on vehicle ${d.vehicleNo}` : ""}`, ref: d.no }] : []),
        ...(p.cancelledAt ? [{ at: p.cancelledAt, text: d.status === "REVERSED" ? `Dispatch reversed: ${d.reverseReason}` : "Barcode retired (draft changed or cancelled)", ref: "" }] : [])
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
      title: "Godowns", one: "godown", save: S.saveGodown,
      cols: [["code", "Code"], ["name", "Name"], ["address", "Address"]],
      fields: g => `
        <label>Code<input name="code" value="${esc(g.code)}" required maxlength="20"></label>
        <label>Name<input name="name" value="${esc(g.name)}" required maxlength="60"></label>
        <label class="span-2">Address<input name="address" value="${esc(g.address)}" maxlength="160"></label>`
    },
    items: {
      title: "Coffee items", one: "item", save: S.saveItem,
      cols: [["code", "Code"], ["name", "Name"], ["coffeeType", "Type"], ["form", "Form"], ["grade", "Grade"], ["bagKg", "Std bag kg"]],
      fields: it => `
        <label>Code<input name="code" value="${esc(it.code)}" required maxlength="30" placeholder="ARA-PCH-A"></label>
        <label>Name<input name="name" value="${esc(it.name)}" required maxlength="60" placeholder="Arabica Parchment A"></label>
        <label>Coffee type<select name="coffeeType">${plainOptions(S.COFFEE_TYPES, it.coffeeType, "Select")}</select></label>
        <label>Form<select name="form">${plainOptions(S.COFFEE_FORMS, it.form, "Select")}</select></label>
        <label>Grade<input name="grade" value="${esc(it.grade)}" maxlength="20" placeholder="A, AB, PB…"></label>
        <label>Standard bag (kg)<input type="number" name="bagKg" value="${esc(it.bagKg || "")}" min="0" step="0.1" placeholder="50"></label>`
    },
    clients: {
      title: "Clients", one: "client", save: S.saveClient,
      cols: [["code", "Code"], ["name", "Name"], ["contactPerson", "Contact"], ["phone", "Phone"], ["gstin", "GSTIN"]],
      fields: c => `
        <label>Code<input name="code" value="${esc(c.code)}" required maxlength="20"></label>
        <label>Name<input name="name" value="${esc(c.name)}" required maxlength="80"></label>
        <label>Contact person<input name="contactPerson" value="${esc(c.contactPerson)}" maxlength="60"></label>
        <label>Phone<input name="phone" value="${esc(c.phone)}" maxlength="20" inputmode="tel"></label>
        <label class="span-2">Delivery address<textarea name="address" rows="2">${esc(c.address)}</textarea></label>
        <label>GSTIN<input name="gstin" value="${esc(c.gstin)}" maxlength="15"></label>`
    }
  };

  function mastersView(kind, editId) {
    const m = MASTER[kind];
    const rec = editId && editId !== "new" ? S.state[kind].find(r => r.id === editId) : null;
    const showForm = editId === "new" || rec;
    const list = S.state[kind].slice().sort((a, b) => (b.active !== false) - (a.active !== false) || a.code.localeCompare(b.code));
    then(() => {
      const f = document.getElementById("masterForm");
      if (f) {
        f.querySelector("input").focus();
        f.addEventListener("submit", e => {
          e.preventDefault();
          const data = formData(f);
          data.id = rec ? rec.id : null;
          data.active = data.active === "on";
          if (attempt(() => m.save(data), `${m.one[0].toUpperCase() + m.one.slice(1)} saved`)) location.hash = `#/masters/${kind}`;
        });
      }
    });
    return `
      <div class="page-head"><div><h1>Masters</h1><p class="sub">Reference data. Records in use are deactivated, never deleted.</p></div>
        <div class="actions"><a class="btn primary" href="#/masters/${kind}/new">+ Add ${m.one}</a></div></div>
      <div class="tabs">${Object.entries(MASTER).map(([k, v]) => `<a href="#/masters/${k}" class="${k === kind ? "active" : ""}">${v.title}</a>`).join("")}</div>
      ${showForm ? `<form class="card form" id="masterForm"><h2>${rec ? "Edit" : "New"} ${m.one}</h2><div class="form-grid">${m.fields(rec || {})}
        <label class="check span-2"><input type="checkbox" name="active" ${!rec || rec.active !== false ? "checked" : ""}> Active</label></div>
        <div class="form-actions"><a class="btn ghost" href="#/masters/${kind}">Cancel</a><button class="btn primary" type="submit">Save</button></div></form>` : ""}
      <section class="card flush">${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${m.cols.map(([, h]) => `<th>${h}</th>`).join("")}<th>Status</th><th></th></tr></thead><tbody>
        ${list.map(r => `<tr class="${r.active === false ? "inactive" : ""}">${m.cols.map(([k]) => `<td class="${k === "code" || k === "gstin" ? "mono" : ""}">${esc(r[k] == null ? "" : r[k])}</td>`).join("")}<td>${r.active === false ? badge("INACTIVE") : `<span class="badge green">ACTIVE</span>`}</td>
          <td><a class="btn small ghost" href="#/masters/${kind}/${esc(r.id)}">Edit</a></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No ${m.title.toLowerCase()} yet.</div>`}</section>`;
  }

  /* ---------- settings ---------- */

  function settingsView() {
    const st = S.state.settings;
    const empty = !S.state.ledger.length && !S.state.dispatches.length;
    then(() => {
      const f = document.getElementById("settingsForm");
      f.addEventListener("submit", e => {
        e.preventDefault();
        const d = formData(f);
        d.labelWidthMm = Math.max(40, Math.min(200, Number(d.labelWidthMm) || 100));
        d.labelHeightMm = Math.max(30, Math.min(200, Number(d.labelHeightMm) || 75));
        if (attempt(() => S.updateSettings(d), "Settings saved")) render();
      });
      document.getElementById("exportBtn").addEventListener("click", () => download(`coffee-stock-backup-${S.today()}.json`, S.exportJson(), "application/json"));
      document.getElementById("importFile").addEventListener("change", e => {
        const file = e.target.files[0];
        if (!file) return;
        if (!confirm("Replace ALL data on this device with the backup file? Take an export first if unsure.")) { e.target.value = ""; return; }
        file.text().then(text => { if (attempt(() => S.importJson(text), "Backup restored")) render(); });
      });
      const demo = document.getElementById("demoBtn");
      if (demo) demo.addEventListener("click", () => { if (attempt(() => S.loadDemo(), "Demo data loaded")) location.hash = "#/"; });
      document.getElementById("testLabel").addEventListener("click", () => {
        const sample = { no: "DSP-TEST-00000", date: S.today(), clientId: null, destination: "Sample address", vehicleNo: "KA 00 XX 0000" };
        const w = st.labelWidthMm, h = st.labelHeightMm;
        printNow(`<div class="labels" style="--lw:${w}mm;--lh:${h}mm"><div class="label"><div class="lb-top"><span class="lb-org">${esc(st.organisation)}</span><span class="lb-pkg">TEST LABEL</span></div>
          <div class="lb-to">${w} × ${h} mm — check the bars are sharp and scan this code.</div><div class="lb-grid"><div class="span-3"><span class="lb-k">Dispatch</span><b>${sample.no}</b></div></div>
          <div class="lb-code">${Code128.svg("PKG-TEST000000", { moduleWidth: 2, height: 50 })}</div><div class="lb-value">PKG-TEST000000</div></div></div>`, `size: ${w}mm ${h}mm; margin: 0;`);
      });
    });
    return `
      <div class="page-head"><div><h1>Settings &amp; backup</h1></div></div>
      <form class="card form" id="settingsForm">
        <h2>Organisation &amp; labels</h2>
        <div class="form-grid">
          <label>Organisation name (on labels &amp; notes)<input name="organisation" value="${esc(st.organisation)}" maxlength="60"></label>
          <label>Your name (recorded on postings)<input name="currentUser" value="${esc(st.currentUser)}" maxlength="40"></label>
          <label class="span-2">Address (on dispatch note)<input name="orgAddress" value="${esc(st.orgAddress || "")}" maxlength="160"></label>
          <label>Label width (mm)<input type="number" name="labelWidthMm" value="${esc(st.labelWidthMm)}" min="40" max="200"></label>
          <label>Label height (mm)<input type="number" name="labelHeightMm" value="${esc(st.labelHeightMm)}" min="30" max="200"></label>
        </div>
        <div class="form-actions"><button type="button" class="btn ghost" id="testLabel">Print test label</button><button class="btn primary" type="submit">Save settings</button></div>
      </form>
      <section class="card">
        <h2>Backup</h2>
        <p class="muted">This Phase 1 build keeps data in this browser on this device. Export a backup regularly; the file restores everything on any device.</p>
        <div class="form-actions start">
          <button class="btn" id="exportBtn">Export backup (.json)</button>
          <label class="btn ghost file-btn">Restore from backup…<input type="file" id="importFile" accept="application/json,.json"></label>
          ${empty ? `<button class="btn ghost" id="demoBtn">Load demo data</button>` : ""}
        </div>
      </section>`;
  }

  /* ---------- downloads ---------- */

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function downloadCsv(name, rows) {
    const cell = v => {
      let s = String(v == null ? "" : v);
      if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; // keep spreadsheet formulas from running
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    download(name, "﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n"), "text/csv");
  }

  /* ---------- global wiring ---------- */

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

  // Another tab changed the data: re-read and redraw.
  window.addEventListener("storage", e => { if (e.key && e.key.startsWith("estate:")) { S.load(); render(); } });

  render();
})();
