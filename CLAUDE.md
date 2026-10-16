# CLAUDE.md

Guidance for Claude (and any developer) working in this repository.

- **Part 1, "How we work"**, is generic. Copy it unchanged into the CLAUDE.md of every new OneUpTech project.
- **Part 2** is specific to OneUpTech Estate. Replace it in other projects.

---

# Part 1 — How we work (all OneUpTech projects)

## The owner
- The owner is not a full-time developer. They deploy from their own laptop and follow instructions literally.
- Give **exact commands, one per line, in run order**, and say what each one should print. Never assume they know git or wrangler details.
- Explain outcomes in plain language: what changed, what they will see, what to do next. Keep replies short; put detail in docs, not chat.
- When they send a screenshot of an error, find the root cause before suggesting a fix. Don't guess-and-retry.

## Hosting pattern (same as FleetApp)
- Cloudflare: **one Worker per app** serves the static web app (`public/`) and the API (`/api/*`), with a **D1** database.
- Custom domain `<app>.oneuptech.co`. A **demo site** `<app>-demo.oneuptech.co` (wrangler `env.demo`) has its own Worker and database for training and testing.
- Stack: TypeScript, Hono, Drizzle (schema and migrations), zod, JWT sign-in with PBKDF2 passwords. Plain HTML/CSS/JS front end with no build step.

## Deploying (the owner runs these; the sandbox cannot reach Cloudflare)
1. `git pull`
2. `npm run demo:deploy`, then check the change on the demo site.
3. `npm run deploy` for the live site.
4. Reload the browser with **Cmd+Shift+R** on a Mac or **Ctrl+F5** on Windows. Static files are cache-busted with `?v=N` in `index.html`; **bump N whenever you change CSS or JS**.

If the user says "not working" after a deploy, check in this order:
1. Is the commit on GitHub?
2. Did their `git pull` get it?
3. Did they deploy after pulling?
4. Is the browser showing a cached copy?

## Works on Windows and Mac
The owner may run every command from a **Windows PC** (PowerShell or Windows Terminal) or a **Mac** (Terminal). Everything must work on both.

- **Setting up a Windows PC:**
  1. Install **Node.js LTS** (nodejs.org) and **Git for Windows** (git-scm.com), with default options.
  2. Open **PowerShell**, then run:
     ```
     git clone https://github.com/smkrmuthu/<repo>
     cd <repo>
     npm install
     npx wrangler login
     ```
  3. After that, the `npm run …` commands are the same as on a Mac. VS Code is optional and has a built-in terminal.
- **Scripts:** write them in Node (`.mjs`), never bash, and keep `npm` scripts to plain commands joined with `&&` (works in PowerShell and cmd too).
  - No `rm`, `cp`, `grep`, `sed`, `export VAR=` or `$(…)` in package.json.
  - Build paths with `node:path` and temp folders with `os.tmpdir()`.
- **Never spawn `npx`/`npm` from Node** with `execFileSync('npx', …)`: it fails on Windows. Run Wrangler through `scripts/wrangler.mjs` (`wranglerSync`, `wranglerSpawn`), which starts the project's own Wrangler with `process.execPath`. Run other Node scripts with `process.execPath` too. Stop background processes with `stopTree()` (uses `taskkill` on Windows).
- **Line endings:** `.gitattributes` keeps LF everywhere. Don't remove it, or Windows checkouts get CRLF in SQL and scripts.
- **When you give the owner commands**, give one form that works in both shells. Where shells differ, give both, labelled **Mac** and **Windows (PowerShell)**. Common ones:

  | Task | Mac (Terminal) | Windows (PowerShell) |
  |---|---|---|
  | Random secret | `openssl rand -hex 32 \| npx wrangler secret put JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \| npx wrangler secret put JWT_SECRET` |
  | Find text in a file | `grep -c "text" public/index.html` | `Select-String -Path public\index.html -Pattern "text"` |
  | Hard refresh | Cmd+Shift+R | Ctrl+F5 |
  | Last commit | `git log --oneline -1` | same |

## Git
- Changes go through a branch and pull request (see Code review below); small doc-only fixes may go straight to `main` if the owner says so. Pull before work and **fetch + rebase before push**: the owner commits from their laptop too, for example database IDs in `wrangler.jsonc`.
- Never use a `git rebase … || git stash` pattern: if the rebase fails, the stash hides your changes.
- Small commits, plain-English messages that say what changed for users.
- Never commit secrets. `JWT_SECRET` is set with `wrangler secret put`. If a secret appears in a screenshot or chat, tell the owner to replace it.

## Data rules that apply to every app
- Business rules are enforced **in the database** (SQLite triggers), not only in the API, so they hold under concurrent requests. The API pre-checks only to give friendly messages.
- Ledgers and audit logs are append-only. Mistakes are undone with an opposite entry, never edited or deleted.
- Quantities are integers in the smallest unit (for example grams). Never floating point.
- Every role check happens on the server. The UI only hides what a role can't do.
- Never run demo or seed data against a live database. Demo data goes to the demo site only.

## Test cases (write them with every change)
Every feature or fix ships with tests. Cover the normal path **and both extremes**, so the test shows where the rule starts and stops working.

- **Normal path:** the everyday case works end to end, for example inward 20 bags, then despatch 5.
- **Lower extreme:** zero, empty, the minimum allowed, and one below it. For example 0 bags with 0 kg is refused; 1 gram is accepted; a missing required field is refused with a clear message.
- **Upper extreme:** exactly the maximum allowed, and one above it. For example despatching all available stock is accepted, but 1 gram more is refused; long text at its length limit; the largest page size.
- **Wrong input:** bad formats, future dates, unknown IDs, duplicates, and a mistyped barcode.
- **Wrong person:** every role the action is *not* allowed for gets refused (403), and the allowed roles succeed. Operators are refused outside their godowns. A disabled user is refused immediately.
- **State rules:** an action at the wrong stage is refused (409/422). Examples: posting twice, undoing twice, printing labels after Truck left, editing something recorded.
- **Concurrency:** when two people can act at once, fire the requests in parallel and assert the database lets exactly one through. Never let stock go below zero.
- **Database rules:** direct SQL that breaks a rule (UPDATE or DELETE on the ledger, changing a barcode) must fail. Keep these tests last, because they reload the local Worker.

Keep tests scalable, so future phases (harvest, fermentation, sorting, …) can add to them without rewriting:
- **One `test()` per rule or feature**, named for the behaviour, for example `'transfer refuses to overdraw'`.
- **Shared helpers** (`api()`, `login()`, balance lookups) at the top of the file, and shared IDs in one object.
- **Each test sets up its own data**, or builds clearly on data created earlier in the file.
- **No real dates or IDs hard-coded:** compute dates from today and read IDs from responses.
- **A new module gets its own test file**, for example `tests/harvest.test.mjs`, using the same helpers. `npm test` runs every `tests/*.test.mjs`.
- **The demo seed script** (`scripts/seed-demo.mjs`) doubles as an end-to-end check on a real site. When a new rule is added, add its refused case there too.

## Code review (every change goes through a pull request)
1. **Branch and PR.** Work on a branch named for the change, for example `feature/scan-to-load` or `fix/transfer-same-godown`. Open a pull request to `main` with:
   - what changed, for users;
   - why;
   - how it was tested (commands run and their results);
   - screenshots for UI changes;
   - anything not verified.
2. **Review before merge.** Review the PR diff as a separate step, as if someone else wrote it, checking:
   - **Correctness:** logic errors, edge cases from the test list above, error messages.
   - **Data safety:** rules held in the database, no float quantities, append-only history kept, migrations reviewed.
   - **Security:** role checks on the server, input validated with zod, no secrets in code, no SQL built from user text.
   - **Tests:** new behaviour and both extremes covered; `npm run typecheck` and `npm test` pass.
   - **UI:** works at 320px and desktop, uses domain wording, quantities bags first, `?v=N` bumped.
   - **Docs:** README, CLAUDE.md and user guides updated where users see a change.
3. **Record the review on GitHub.**
   - Post each finding as a PR review comment on the exact line, with its severity (**blocker**, **should fix** or **nit**) and the suggested fix.
   - A finding that is out of scope for this PR becomes a **GitHub issue**, labelled (`bug`, `enhancement`, `tech-debt`) and linked from the PR comment.
   - Never leave a finding only in chat.
4. **Fix, then re-check.** Push fixes to the same PR, reply on each comment with what changed (or why not), and resolve it. Merge only when:
   - CI and tests are green;
   - no blocker comments are open;
   - the owner has approved.
5. **After merge:** the owner deploys (demo first, then live). Close the issues the PR fixed, with "Fixes #N" in the PR description.

## Before you say "done"
- `npm run typecheck` and `npm test` must pass, including the new tests above.
- For UI changes, run the app locally (`wrangler dev`) and check it in a browser at desktop (1366px) and phone (320–440px) widths with Playwright. The page must never be wider than the screen.
- The PR has its review comments posted, and any follow-ups filed as issues.
- Report what you verified and what you could not, for example "deploy not run from here".

## Sandbox gotchas (Claude Code cloud sessions)
- Never `pkill -f "wrangler dev"` in a command line that itself contains that text: it kills your own shell. Use `pkill -f "[w]orkerd"` in its own call.
- Local D1 data lives under `--persist-to <dir>` and is keyed by `database_id`. If the ID changes, the local copy looks empty, so recreate it.
- Start `wrangler dev` detached (`setsid … &`) and wait for `/api/v1/health` before testing.
- Playwright is preinstalled at `/opt/node22/lib/node_modules/playwright`. Don't run `playwright install`.

## Look and wording
- Use domain words the users use (for example "Despatch", "Inward", "godown"), not developer words. The database can keep its own codes; translate them on screen.
- Every page works on a phone: bottom tab bar, tables become cards, tap targets 44px or more.
- Colours come from CSS tokens on `:root`, with dark mode under `prefers-color-scheme`. Text contrast is at least 4.5:1.

## Documents
- Keep the user guide and the Google Docs in step with every user-visible change. Edit Google Docs **in place** with the Google Docs connector so links stay the same. Never create a duplicate without asking.
- Write docs in plain language: what the page is for, what to enter, what happens.

## Chats, computers and new projects
- **Chats follow the owner's Claude account.** Chats on claude.ai, in the Claude app and in cloud Claude Code sessions (claude.ai/code) show on every device: Mac, Windows PC and phone. Claude Projects (claude.ai folders for chats and files) do too. A session started in a computer's own terminal stays on that computer only.
- **Nothing lives on one computer.** Code and CLAUDE.md are on GitHub, docs are in Google Drive, the sites are at Cloudflare. A second computer needs only a one-time `git clone`, `npm install` and `npx wrangler login`; after that, `git pull` before every deploy.
- **Starting a new project:**
  1. The owner creates a new GitHub repository (for example `smkrmuthu/newProject`).
  2. Copy this CLAUDE.md into its root. Keep Part 1 unchanged; replace Part 2 with the new project's sites, commands, layout and rules. If the owner says "start the new project with my CLAUDE.md from estatePhase1", do exactly this.
  3. The owner starts a new cloud session at claude.ai/code on the new repository, so Claude reads CLAUDE.md from the first message.
  4. On the computer they deploy from, the owner runs `git clone` once; then `git pull` keeps it current.
- **One project per chat.** Keep each project in its own chat or session so work doesn't get mixed up. Add a repository to a session only when the task needs it.
- When these steps change, update this section and section 11 of the Important Steps doc together.

---

# Part 2 — OneUpTech Estate

Coffee stock in godowns and despatch to clients, with a Code 128 barcode on every bag. Phase 1 covers **Store** and **Deliver**. Later phases are Harvest, Ferment and Sort, which attach to the same lots.

- **Live:** https://estate.oneuptech.co (Worker `estate`, D1 `estate-db`)
- **Demo:** https://estate-demo.oneuptech.co (`env.demo`: Worker `estate-demo`, D1 `estate-demo-db`), with sample data for Yard1 (Munnar) and Yard2 (Cochin)
- **Repo:** `smkrmuthu/estatePhase1`, branch `main`

## Commands
```bash
npm run dev                  # local Worker + app at http://localhost:8787
npm run typecheck
npm test                     # API tests (own wrangler dev + throwaway D1) + barcode tests
npm run db:generate          # after editing drizzle/schema.ts → new migrations/000N_*.sql
npm run deploy               # live: migrations + deploy
npm run demo:deploy          # demo: migrations + deploy
npm run demo:setup -- --reset            # empty the demo site and refill it (asks to confirm)
npm run seed:demo -- --url <site> --login <admin>   # demo data + 17 rule checks (--size full: 28)
npm run user:list:remote / user:reset:remote -- --login <login>   # add --env demo --db estate-demo-db for demo
```

## Layout
```
public/index.html, css/estate.css, js/app.js (all screens), js/api.js, js/code128.js
public/img/estate-photo.webp   sign-in photo (swap the file to change it); estate-art.svg = fallback
src/index.ts                   Hono app under /api/v1
src/routes/                    auth, org, users, masters, stock, dispatches (+ trace, dashboard, CSV)
src/lib/stock.ts               balances, availability check, posting
drizzle/schema.ts              schema (source of truth)
migrations/0001_stock_rules.sql  the stock rules as triggers
scripts/                       create-user, seed-demo, setup-demo; wrangler.mjs = cross-platform Wrangler runner
tests/api.test.mjs             integration tests (direct-SQL test must stay last)
```

## Rules to keep
- **Screen wording vs stored codes:** RECEIPT → Inward, DISPATCH → Despatch, DRAFT → Loading, DISPATCHED → Despatched, REVERSED → Undone, POSTED → Recorded, REVERSAL → Undo, ledger → Stock register.
- **Bags first, kg underneath**, everywhere quantities appear.
- **Despatch flow:** save → **Loading** (stock held, barcodes issued) → print labels and optionally weigh → **Truck left — confirm** (stock deducted).
  - Labels can only be printed while Loading; the server refuses otherwise.
  - Editing lines replaces the barcodes. Old codes still scan and show as Cancelled.
- **Barcodes:** `PKG-` + 10 Crockford Base32 characters + a check character. They are immutable and never reused.
- **Adjustment reasons depend on direction** (`ADJUSTMENT_REASONS` in `src/routes/stock.ts`). "Other" needs a note.
- **Roles:** admin, manager, operator (only the godowns ticked in `user_godowns`), viewer. The auth middleware reloads the user on every request.
- **Theme:** coffee `#5b3a1e`, parchment `#f8f3ea`, teal links `#0e7f77`, gold `#b08a3e`, cherry `#a8322d` (warnings only), chart caramel `#a8682a`. Fraunces for headings, Inter for text, monospace only for codes.
- **Sign-in tagline:** "GROW MORE. MANAGE BETTER." / "From cherry to cargo — every step, every bag." with the strip Harvest · Ferment · Sort · **Store · Deliver**. Light up a step when its phase ships.

## Docs to update with user-visible changes
- User guide (Claude Doc): https://claude.ai/code/artifact/b68f66b5-a1cc-4341-b4bd-2282437b0181
- Live Google Docs:
  - User Guide: https://docs.google.com/document/d/1X6HuTSlF7Vq6qD_reZu25bAMc0HX0VDfLRus_rfu3Zk/edit
  - Roles and Page Access: https://docs.google.com/document/d/1HintHIxXspkQxyv2s1MiMbrv5MiVqaIPqafVh2meVXI/edit
- Demo Google Docs:
  - User Guide: https://docs.google.com/document/d/1ie3b08tdxXKL8l4rO6ecFg2gJnGotpshh0Lg4KaB8Fs/edit
  - Roles and Page Access: https://docs.google.com/document/d/1xVni8ITeerI5diRibP8JWVaM9tMJOX3v-68FBWJFiCI/edit
- Important Steps (both sites): https://docs.google.com/document/d/1YJAzQfLpcugx9dlGBZWIH2w2E1qj01xY2_g-mjDQ0bw/edit
- `README.md` in this repo

## Planned, not built
- Scan to load: check each packed bag onto the truck before Truck left.
- Returns, and physical stock counts.
- Harvest, fermentation and sorting phases, linked to lots via `source_type` / `source_id`.
