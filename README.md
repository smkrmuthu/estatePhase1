# OneUpTech Estate — Phase 1

**Grow more. Manage better.** Coffee stock held in godowns, distributed to clients, with a barcode on every package that carries the dispatch details for tracking.

Live at **https://estate.oneuptech.co** once set up (see *Hosting*).

## What Phase 1 does

| Goal | How |
|---|---|
| Maintain coffee stock in godowns | **Inward** (incl. opening stock), transfer between godowns, adjust with a reason code. **Stock on hand** shows each godown + lot in bags and kg, with what is held for loading and what is available. Every entry is in the **Stock register**. |
| Distribute to clients | **New despatch**: client, vehicle, driver, destination, and lines (godown + lot + bags + kg). Saving holds the stock (status *Loading*); **Truck left — confirm** deducts it. |
| Barcodes when delivering | Each package (normally one per bag) gets a Code 128 barcode when the draft is saved, so labels go on before loading. |
| Barcode delivered with dispatch details | Labels show client, address, dispatch no., date, vehicle, coffee, lot, net weight and *package n of N*. The A4 **dispatch note** lists every package barcode. Scanning a label shows the full trace. |
| Multi-user | Sign-in, four roles, godown-level access for operators, audit trail. |
| Tables/fields only as needed; ready for earlier steps | See *Data model* and *Extending to earlier steps*. |

## Stack

Same family as FleetApp: **Cloudflare Workers + D1 (SQLite) + Hono + Drizzle (schema & migrations) + zod**, JWT sign-in with PBKDF2 password hashing.

Unlike FleetApp, the web app and the API are **one Worker on one domain**: Cloudflare serves the files in `public/` directly, and only `/api/*` runs Worker code. That means one deploy, no CORS setup, and no API URL to configure.

```
public/            the web app (plain HTML/CSS/JS, no build step)
  js/app.js        screens, printing
  js/api.js        API client (token, errors)
  js/code128.js    barcode encoder
src/               the API (Hono)
  routes/          auth, org, users, masters, stock, dispatches (+ trace, dashboard, CSV)
  lib/stock.ts     balances, availability check, posting
  lib/barcode.ts   barcode values with check character
drizzle/schema.ts  database schema (source of truth)
migrations/        0000 tables (generated) · 0001 stock-rule triggers (hand-written)
scripts/create-user.mjs   create the first admin (or any user) from the command line
tests/             API integration tests (real Worker + local D1) and barcode tests
wrangler.jsonc     Worker "estate", D1 "estate-db", domain estate.oneuptech.co
```

## Screen wording

The screens use estate words; the database and API keep their original codes:

| Screen says | Stored as |
|---|---|
| Inward | RECEIPT |
| Despatch | DISPATCH |
| Loading / Despatched / Undone | DRAFT / DISPATCHED / REVERSED |
| Recorded | POSTED |
| Undo | REVERSAL |
| Stock register | stock ledger |

Look and feel: roasted-coffee brown for actions, parchment cream background, teal links, harvest-gold accents, cherry red only for warnings; Fraunces for headings, Inter for text, monospace only for codes (LOT-…, PKG-…). Quantities show bags first, kg underneath.

## On a phone

Below 760 px wide the app switches to phone mode: a bottom tab bar (Home, Inward or Stock, **Scan**, Despatch, More), tables shown as cards, and larger tap targets. **More** opens the full menu.

**Scan** opens the camera and reads a bag label's Code 128 barcode by itself, then shows that bag's trace. It uses the phone's built-in barcode reader where there is one (Android Chrome) and otherwise loads the bundled ZXing decoder (`public/vendor/zxing-0.21.3.min.js`, MIT licence, about 100 KB compressed) on first use. Camera access needs HTTPS (the live site) or localhost. A USB/Bluetooth scanner and typing the code still work everywhere.

## Home page by role

- **Godown operator:** a "today" page for their own godowns: big Inward / New despatch / Scan buttons, bags arrived and despatched today (undos net out), despatches being loaded there, stock in their godowns, and today's entries.
- **Administrator, manager, viewer:** totals, a column chart of bags despatched per month (last 6 months, with a table view), bar charts of stock by coffee and by godown, despatches being loaded, and recent activity. Chart bars use caramel (`--chart`), checked for lightness, colour strength and contrast in light and dark mode.

Undo, cancel and "Truck left" use in-app dialogs: what will happen, a reason picker (required for undo; "Other" needs a note), and one clear action.

## Roles

| Role | Can |
|---|---|
| Administrator | Everything, plus users and organisation settings |
| Manager | Masters, all stock postings, adjustments, reversals |
| Godown operator | Receive, transfer and dispatch — only in godowns assigned to them |
| Viewer | Read only |

The API enforces these on every request (the screens just hide what you can't do). Disabling a user or changing their role takes effect on their next click.

## How stock stays correct

- **Ledger first.** Every receipt, transfer, adjustment, dispatch and reversal writes signed ledger rows (grams + bags). Balances are always computed from the ledger.
- **All-or-nothing postings.** Each posting is one D1 batch: either everything is saved or nothing is.
- **Rules inside the database** (`migrations/0001_stock_rules.sql`), so they hold even when two people post at the same second:
  - a godown + lot can never go below zero, or below what draft dispatches hold;
  - ledger rows and posted transactions can't be edited or deleted — mistakes are **reversed** with an opposite entry, once;
  - a dispatch can be posted only once, and only if its package weights add up exactly to its lines;
  - package barcodes can never change or be deleted, and are never reused.
- **Whole grams.** Quantities are integers (grams), never floating point.

## Dispatch & barcode rules

1. **Save draft & issue barcodes** — stock is held; one package per bag with a barcode like `PKG-6ERM2G1WMXC`.
2. **Weigh (optional)** — enter actual net kg per package; totals must equal the line before posting.
3. **Post dispatch** when the vehicle leaves — stock is deducted, packages become *DISPATCHED*.
4. Editing a draft's lines retires old barcodes and issues new ones. A retired barcode still scans and shows it was retired.
5. **Reverse** (managers) only if the goods did not leave. Returned goods are a later feature.

Barcodes use Crockford Base32 (no I/L/O/U) plus a check character, so a mistyped code is rejected instead of matching another package. Any USB/Bluetooth scanner that types like a keyboard works in the top search bar on every screen.

## Hosting (Cloudflare, same account as fleet.oneuptech.co)

One-time setup, from a laptop with Node 20+:

```bash
git clone https://github.com/smkrmuthu/estatePhase1 && cd estatePhase1
npm install
npx wrangler login

# 1. Create the database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create estate-db

# 2. Create the tables and stock rules
npm run db:migrate:remote

# 3. Set the sign-in secret (paste a long random string, e.g. from: openssl rand -hex 32)
npx wrangler secret put JWT_SECRET

# 4. Create the first administrator (prompts for a password)
npm run user:create:remote -- --org "Your Estate Name" --login you@example.com --name "Your Name" --role admin

# 5. Deploy (applies any new migrations, then deploys the Worker + app)
npm run deploy
```

Commit the `database_id` change from step 1. The domain `estate.oneuptech.co` is attached automatically on deploy, because the `oneuptech.co` zone is already on this account. If Cloudflare says the domain is in use, remove it from wherever it's attached, or add it under the Worker's **Settings → Domains & Routes**.

**Automatic deploys (optional):** in the Cloudflare dashboard, **Workers & Pages → estate → Settings → Build**, connect `smkrmuthu/estatePhase1`, branch `main`, deploy command `npm run deploy`. Every push to `main` then migrates and deploys. If the build token can't run D1 migrations, use `npx wrangler deploy` as the deploy command and run `npm run db:migrate:remote` by hand when a migration is added.

After that, add the rest of the team under **Users** in the app.

**Forgot the admin login or password?** From the same laptop:

```bash
npm run user:list:remote                                   # shows every login
npm run user:reset:remote -- --login you@example.com       # asks for a new password
```

Other users' passwords are reset by an admin in the app (**Users → Edit**).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars            # local-only JWT secret
npm run db:migrate:local
npm run user:create:local -- --login admin --name "Admin" --password localpass123
npm run dev                               # http://localhost:8787
```

```bash
npm test          # API integration tests (starts its own Worker + throwaway D1) + barcode tests
npm run typecheck
```

## Changing the database

1. Edit `drizzle/schema.ts`.
2. `npm run db:generate` — writes a new `migrations/000N_*.sql`. Review it.
3. `npm run db:migrate:local` and `npm test`.
4. Push; `npm run deploy` applies it to production.

Triggers and other SQL that Drizzle can't express go in a custom migration (`npx drizzle-kit generate --custom --name <what>`).

## Data model (Phase 1)

| Table | Key fields |
|---|---|
| orgs | name, address, label size |
| users, user_godowns | login, name, role, password hash; godowns an operator may post in |
| locations | godowns today (`kind`, `parent_id` leave room for stacks/bays or estates/blocks) |
| items | code, name, coffee type, form (Parchment/Cherry/Clean), grade, standard bag weight |
| clients | code, name, contact, phone, delivery address, GSTIN |
| lots | code, item, **source_type + source_id + source_ref**, crop year, moisture %, outturn % |
| stock_txns / stock_ledger | posted transactions and their signed ledger rows (grams, bags) |
| dispatches / dispatch_lines / dispatch_packages | header, lines, packages with barcodes |
| counters | document numbers (RCV-2026-00001, DSP-…, LOT-…) |
| audit_log | who did what, when (append-only) |

## Extending to earlier steps (sourcing, cultivation, fermentation, processing)

- **Lots record where they came from.** Today every lot is `source_type = RECEIPT`. A sourcing or harvest module adds its own tables and creates lots with `source_type` HARVEST / PURCHASE / PROCESSING and `source_id` pointing at them.
- **Processing is a new transaction type.** For example, hulling parchment into clean coffee consumes input lots and creates output lots; a `lot_links` table records parent → child. A package barcode can then trace back through processing to the estate block.
- **Locations are hierarchical**, so estates, divisions and blocks can sit alongside godowns.
- **The barcode stays the anchor.** Labels can later show provenance, but the encoded value stays an opaque ID, so old labels keep working.

## Not in Phase 1

Sourcing/purchasing, cultivation, fermentation/processing, quality lab, invoicing/payments, returns of goods, physical stock counts, transport integration, a customer portal, file attachments, offline use.
