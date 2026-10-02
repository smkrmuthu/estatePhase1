# Coffee Stock & Distribution — Phase 1

Estate app for coffee held in godowns and dispatched to clients. Every package sent out gets its own barcode, printed with the dispatch details, so it can be traced later.

Live at **https://estate.oneuptech.co** (Cloudflare), once connected as described under *Hosting*.

## Phase 1 goals and where they are met

| Goal | How |
|---|---|
| Maintain coffee stock in godowns | Receive, transfer, adjust (with reason codes) and an opening balance. **Stock on hand** shows each godown and lot in kg and bags, with what drafts hold and what is available. Every movement is in the **Stock ledger**. |
| Distribute to clients | **New dispatch**: client, vehicle, driver, destination and lines (godown + lot + bags + kg). A draft holds the stock; **Post dispatch** deducts it. |
| Barcodes when delivering | Saving a dispatch issues one Code 128 barcode per package (normally one per bag). Labels print at 100 × 75 mm by default (adjustable). |
| Barcode delivered with dispatch details | Each label carries client, address, dispatch no., date, vehicle, coffee, lot, net weight and *package n of N*. The A4 **dispatch note** lists every package barcode for the driver and consignee. Scanning any label (top search bar or **Track barcode**) shows the full trace. |
| Tables/fields added only when required | Only the fields needed now (see *Data model*). `store.js` explains how to add a field or reshape data safely. |
| Ready for sourcing / cultivation / fermentation later | See *Extending to earlier steps*. |

## Project layout

```
public/          the app (plain HTML/CSS/JS, no build step) — this folder is what gets hosted
  index.html
  js/store.js    stock, dispatch and barcode rules
  js/app.js      screens, printing
  js/code128.js  barcode encoder
  _headers       security headers for Cloudflare
tests/           Node tests for store.js and the barcode encoder
db/              target multi-user database schema + its tests
wrangler.jsonc   Cloudflare config (Worker "estate", domain estate.oneuptech.co)
```

## Running locally

```bash
npx wrangler dev          # http://localhost:8787 — same server Cloudflare uses
# or any static server:  python3 -m http.server 4173 --directory public
```

To explore quickly: **Settings & backup → Load demo data**.

Tests:

```bash
npm test                                                             # stock rules, barcodes
psql -v ON_ERROR_STOP=1 -d <empty db> -f db/schema.sql -f db/test_schema.sql
```

## Hosting (Cloudflare, same account as fleet.oneuptech.co)

The app is a static-assets Cloudflare Worker named `estate`; `wrangler.jsonc` serves `public/` and claims the custom domain `estate.oneuptech.co`.

One-time setup in the Cloudflare dashboard:

1. **Workers & Pages → Create application → Import a repository** (Workers tab, not Pages) → pick `smkrmuthu/estatePhase1`.
2. Project name `estate`. Build command: *(leave empty)*. Deploy command: `npx wrangler deploy` (the default). Root directory: `/`.
3. Save and deploy. Every push to `main` then redeploys automatically.
4. The custom domain `estate.oneuptech.co` is attached on deploy (from `wrangler.jsonc`), because the `oneuptech.co` zone is already on this account. If the deploy reports the domain is in use, remove it from wherever it is attached, or add it under the Worker's **Settings → Domains & Routes**.

Manual deploy from a laptop instead: `npx wrangler login`, then `npm run deploy`.

## Important: where data is stored in this build

Phase 1 keeps data **in the browser on the device you use** (localStorage). That is fine for a pilot on one godown PC. It is **not** shared between devices or users yet. Use **Settings → Export backup** regularly.

`db/schema.sql` is the shared, multi-user version of the same model (written and tested for PostgreSQL), with the same rules enforced inside the database and tested by `db/test_schema.sql`. Next increment: a shared backend with logins and per-godown access. To match FleetApp, that would be a Cloudflare Worker API + D1 database, with this schema carried over as D1 migrations.

## How stock works

- **Ledger first.** Every receipt, transfer, adjustment, dispatch and reversal writes signed ledger rows (grams + bags). Balances are always computed from the ledger, so they can't drift.
- **Nothing posted is edited.** Mistakes are corrected with **Reverse**, which posts the opposite movement and keeps both records.
- **No negative stock.** A posting that would take a godown + lot below zero, or below what draft dispatches hold, is refused and nothing is saved.
- **Whole grams.** Quantities are stored as integer grams to avoid rounding drift; screens show kg.

## Dispatch and barcode rules

1. **Save draft & issue barcodes.** Stock is held and one package per bag is created, each with a barcode like `PKG-D6E66YT2W18`. The barcodes exist before loading, so labels can be printed and stuck on the bags.
2. **Weigh (optional).** Enter the actual net kg per package. Package totals must equal the line totals exactly before posting.
3. **Post dispatch** when the vehicle leaves: stock is deducted and packages become *DISPATCHED*.
4. Changing a draft's lines retires its old barcodes and issues new ones. **A barcode is never reused.** A retired barcode still resolves and shows that it is retired.
5. **Reverse** a posted dispatch only if the goods did not leave. Goods physically coming back (returns) are a later feature.

Barcode values use Crockford Base32 (no I/L/O/U) plus a check character, so a mistyped code is rejected rather than matching a different package. The encoder was checked against `python-barcode` bit for bit, and printed labels and dispatch notes were decoded with a barcode reader during testing.

Scanners: any USB/Bluetooth scanner that types like a keyboard works in the top bar from any screen.

## Data model (Phase 1)

| Record | Key fields |
|---|---|
| Godown | code, name, address, active |
| Coffee item | code, name, coffee type (Arabica/Robusta), form (Parchment/Cherry/Clean), grade, standard bag kg |
| Client | code, name, contact, phone, delivery address, GSTIN |
| Lot | code, item, **source type + source ref**, crop year, moisture %, outturn % |
| Transaction | no., type (OPENING, RECEIPT, TRANSFER, ADJUSTMENT, DISPATCH, REVERSAL), status, date, reference, reason |
| Ledger row | transaction, godown, lot, ± grams, ± bags |
| Dispatch | no., client, date, destination, vehicle, transporter, driver, status (DRAFT → DISPATCHED / CANCELLED / REVERSED), lines |
| Package | dispatch, line, seq, **barcode**, grams, bags, status (PREPARED → DISPATCHED / CANCELLED), print count |
| Audit event | who, when, what |

## Extending to earlier steps (sourcing, cultivation, fermentation, processing)

The design leaves room for these without changing anything already built:

- **Lots record where they came from.** Today every lot is `sourceType: RECEIPT`. A sourcing or harvest module adds its own records and creates lots with `sourceType: HARVEST` / `PURCHASE` pointing at them.
- **Processing becomes a new transaction type.** For example, hulling parchment into clean coffee consumes input lots and creates output lots. A `lot_link` table records parent → child, so a package barcode can trace back through processing to the estate block.
- **Locations are hierarchical** (`location.parent_id`, `kind`), so estates, divisions and blocks can sit alongside godowns.
- **The barcode stays the anchor.** Labels can later show provenance, but the encoded value stays an opaque ID, so old labels keep working.

## Not in Phase 1 (deliberately)

Sourcing/purchasing, cultivation, fermentation/processing, quality lab, invoicing/payments, returns of goods, transport integration, a customer portal, file attachments, user logins/roles (comes with the shared database), and offline sync across devices.
