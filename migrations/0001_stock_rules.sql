-- Stock rules enforced inside the database, so they hold even when two people
-- post at the same moment. The API checks the same things first to give a
-- friendly message; these triggers are the guarantee. Messages starting with
-- "ESTATE:" are translated by src/lib/errors.ts.
--
-- Postings are sent as one D1 batch (all-or-nothing), so a trigger that aborts
-- rolls back the whole posting.

-- ── Ledger: append-only, never negative, never below draft holds ─────────────
CREATE TRIGGER stock_ledger_no_update BEFORE UPDATE ON stock_ledger
BEGIN SELECT RAISE(ABORT, 'ESTATE:ledger_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER stock_ledger_no_delete BEFORE DELETE ON stock_ledger
BEGIN SELECT RAISE(ABORT, 'ESTATE:ledger_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER stock_ledger_same_org BEFORE INSERT ON stock_ledger
WHEN NOT EXISTS (SELECT 1 FROM stock_txns WHERE id = NEW.txn_id AND org_id = NEW.org_id)
  OR NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW.location_id AND org_id = NEW.org_id)
  OR NOT EXISTS (SELECT 1 FROM lots WHERE id = NEW.lot_id AND org_id = NEW.org_id AND item_id = NEW.item_id)
BEGIN SELECT RAISE(ABORT, 'ESTATE:cross_org'); END;
--> statement-breakpoint
-- After each ledger row: the godown + lot must not be negative, and what is left
-- must still cover quantities held by OTHER draft dispatches (a dispatch being
-- posted is already DISPATCHED by the time its ledger rows are written).
CREATE TRIGGER stock_ledger_no_negative AFTER INSERT ON stock_ledger
WHEN (SELECT COALESCE(SUM(grams), 0) FROM stock_ledger WHERE location_id = NEW.location_id AND lot_id = NEW.lot_id) < 0
  OR (SELECT COALESCE(SUM(bags), 0) FROM stock_ledger WHERE location_id = NEW.location_id AND lot_id = NEW.lot_id) < 0
  OR (SELECT COALESCE(SUM(grams), 0) FROM stock_ledger WHERE location_id = NEW.location_id AND lot_id = NEW.lot_id)
     < (SELECT COALESCE(SUM(l.grams), 0) FROM dispatch_lines l JOIN dispatches d ON d.id = l.dispatch_id
        WHERE d.status = 'DRAFT' AND l.superseded_at IS NULL AND l.location_id = NEW.location_id AND l.lot_id = NEW.lot_id)
  OR (SELECT COALESCE(SUM(bags), 0) FROM stock_ledger WHERE location_id = NEW.location_id AND lot_id = NEW.lot_id)
     < (SELECT COALESCE(SUM(l.bags), 0) FROM dispatch_lines l JOIN dispatches d ON d.id = l.dispatch_id
        WHERE d.status = 'DRAFT' AND l.superseded_at IS NULL AND l.location_id = NEW.location_id AND l.lot_id = NEW.lot_id)
BEGIN SELECT RAISE(ABORT, 'ESTATE:insufficient_stock'); END;
--> statement-breakpoint

-- ── Transactions: posted facts don't change; reversal only once ──────────────
CREATE TRIGGER stock_txns_no_delete BEFORE DELETE ON stock_txns
BEGIN SELECT RAISE(ABORT, 'ESTATE:ledger_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER stock_txns_only_reverse BEFORE UPDATE ON stock_txns
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.no IS NOT OLD.no OR NEW.type IS NOT OLD.type
  OR NEW.effective_date IS NOT OLD.effective_date OR NEW.posted_at IS NOT OLD.posted_at OR NEW.posted_by IS NOT OLD.posted_by
  OR NEW.reverses_id IS NOT OLD.reverses_id OR NEW.dispatch_id IS NOT OLD.dispatch_id
  OR NOT (NEW.status = OLD.status OR (OLD.status = 'POSTED' AND NEW.status = 'REVERSED'))
BEGIN SELECT RAISE(ABORT, 'ESTATE:ledger_immutable'); END;
--> statement-breakpoint
-- A REVERSAL row is only valid if the same batch has just marked its original REVERSED.
CREATE TRIGGER stock_txns_reversal_valid AFTER INSERT ON stock_txns
WHEN NEW.type = 'REVERSAL' AND NOT EXISTS (
  SELECT 1 FROM stock_txns WHERE id = NEW.reverses_id AND org_id = NEW.org_id AND status = 'REVERSED' AND type <> 'REVERSAL')
BEGIN SELECT RAISE(ABORT, 'ESTATE:not_reversible'); END;
--> statement-breakpoint
-- A DISPATCH row is only valid if the same batch has just moved its dispatch from
-- DRAFT to DISPATCHED (so a dispatch can't be posted twice), and every line's
-- packages add up exactly to the line.
CREATE TRIGGER stock_txns_dispatch_valid AFTER INSERT ON stock_txns
WHEN NEW.type = 'DISPATCH' AND (
  NOT EXISTS (SELECT 1 FROM dispatches WHERE id = NEW.dispatch_id AND org_id = NEW.org_id AND status = 'DISPATCHED' AND txn_id = NEW.id)
  OR EXISTS (
    SELECT 1 FROM dispatch_lines l
    WHERE l.dispatch_id = NEW.dispatch_id AND l.superseded_at IS NULL
      AND (l.grams <> (SELECT COALESCE(SUM(p.grams), 0) FROM dispatch_packages p WHERE p.line_id = l.id AND p.status <> 'CANCELLED')
        OR l.bags <> (SELECT COALESCE(SUM(p.bags), 0) FROM dispatch_packages p WHERE p.line_id = l.id AND p.status <> 'CANCELLED'))))
BEGIN SELECT RAISE(ABORT, 'ESTATE:dispatch_not_postable'); END;
--> statement-breakpoint

-- ── Dispatch lines: only on drafts, and only within available stock ─────────
CREATE TRIGGER dispatch_lines_draft_only BEFORE INSERT ON dispatch_lines
WHEN NOT EXISTS (SELECT 1 FROM dispatches WHERE id = NEW.dispatch_id AND org_id = NEW.org_id AND status = 'DRAFT')
  OR NOT EXISTS (SELECT 1 FROM lots WHERE id = NEW.lot_id AND org_id = NEW.org_id AND item_id = NEW.item_id)
  OR NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW.location_id AND org_id = NEW.org_id)
  OR NEW.grams <= 0 OR NEW.bags < 0 OR NEW.packages < 1
BEGIN SELECT RAISE(ABORT, 'ESTATE:dispatch_not_draft'); END;
--> statement-breakpoint
CREATE TRIGGER dispatch_lines_within_stock AFTER INSERT ON dispatch_lines
WHEN (SELECT COALESCE(SUM(grams), 0) FROM stock_ledger WHERE location_id = NEW.location_id AND lot_id = NEW.lot_id)
     < (SELECT COALESCE(SUM(l.grams), 0) FROM dispatch_lines l JOIN dispatches d ON d.id = l.dispatch_id
        WHERE d.status = 'DRAFT' AND l.superseded_at IS NULL AND l.location_id = NEW.location_id AND l.lot_id = NEW.lot_id)
  OR (SELECT COALESCE(SUM(bags), 0) FROM stock_ledger WHERE location_id = NEW.location_id AND lot_id = NEW.lot_id)
     < (SELECT COALESCE(SUM(l.bags), 0) FROM dispatch_lines l JOIN dispatches d ON d.id = l.dispatch_id
        WHERE d.status = 'DRAFT' AND l.superseded_at IS NULL AND l.location_id = NEW.location_id AND l.lot_id = NEW.lot_id)
BEGIN SELECT RAISE(ABORT, 'ESTATE:insufficient_stock'); END;
--> statement-breakpoint
CREATE TRIGGER dispatch_lines_frozen BEFORE UPDATE ON dispatch_lines
WHEN (SELECT status FROM dispatches WHERE id = OLD.dispatch_id) <> 'DRAFT'
  OR NEW.grams IS NOT OLD.grams OR NEW.bags IS NOT OLD.bags OR NEW.lot_id IS NOT OLD.lot_id
  OR NEW.location_id IS NOT OLD.location_id OR NEW.dispatch_id IS NOT OLD.dispatch_id OR OLD.superseded_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'ESTATE:dispatch_not_draft'); END;
--> statement-breakpoint
CREATE TRIGGER dispatch_lines_no_delete BEFORE DELETE ON dispatch_lines
BEGIN SELECT RAISE(ABORT, 'ESTATE:dispatch_not_draft'); END;
--> statement-breakpoint

-- ── Packages: barcode fixed forever, never deleted, weights only on drafts ──
CREATE TRIGGER dispatch_packages_draft_only BEFORE INSERT ON dispatch_packages
WHEN NOT EXISTS (SELECT 1 FROM dispatches WHERE id = NEW.dispatch_id AND org_id = NEW.org_id AND status = 'DRAFT')
  OR NOT EXISTS (SELECT 1 FROM dispatch_lines WHERE id = NEW.line_id AND dispatch_id = NEW.dispatch_id AND lot_id = NEW.lot_id)
BEGIN SELECT RAISE(ABORT, 'ESTATE:dispatch_not_draft'); END;
--> statement-breakpoint
CREATE TRIGGER dispatch_packages_identity BEFORE UPDATE ON dispatch_packages
WHEN NEW.barcode IS NOT OLD.barcode OR NEW.dispatch_id IS NOT OLD.dispatch_id OR NEW.line_id IS NOT OLD.line_id
  OR NEW.lot_id IS NOT OLD.lot_id OR NEW.seq IS NOT OLD.seq OR NEW.org_id IS NOT OLD.org_id
  OR (OLD.status = 'CANCELLED' AND NEW.status IS NOT OLD.status)
BEGIN SELECT RAISE(ABORT, 'ESTATE:barcode_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER dispatch_packages_weight_on_draft BEFORE UPDATE OF grams, bags ON dispatch_packages
WHEN (NEW.grams IS NOT OLD.grams OR NEW.bags IS NOT OLD.bags)
  AND (NEW.grams <= 0 OR NEW.bags < 0 OR OLD.status <> 'PREPARED'
       OR (SELECT status FROM dispatches WHERE id = OLD.dispatch_id) <> 'DRAFT')
BEGIN SELECT RAISE(ABORT, 'ESTATE:dispatch_not_draft'); END;
--> statement-breakpoint
CREATE TRIGGER dispatch_packages_no_delete BEFORE DELETE ON dispatch_packages
BEGIN SELECT RAISE(ABORT, 'ESTATE:barcode_immutable'); END;
--> statement-breakpoint

-- ── Audit log: append-only ────────────────────────────────────────────────
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'ESTATE:audit_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'ESTATE:audit_immutable'); END;
