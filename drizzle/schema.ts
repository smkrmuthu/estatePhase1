import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

// ─────────────────────────────────────────────────────────────────────────
// Quantities are whole GRAMS (integer) plus a whole BAG count. Never a float —
// SQLite's REAL is a double and rounding it is how a stock ledger drifts.
//
// Every tenant-scoped table carries org_id. D1 (SQLite) has no row-level
// security, so isolation is enforced centrally in src/middleware/auth.ts:
// every query is scoped to the caller's org_id from the verified JWT, never
// from the request body.
//
// Stock rules that must hold even under concurrent use are enforced by
// triggers in migrations/0001_stock_rules.sql (drizzle-kit can't express
// triggers): the ledger is append-only, a godown + lot can never go below
// zero or below what draft dispatches hold, and barcodes never change.
//
// EXTENDING TO EARLIER STEPS (sourcing, cultivation, fermentation, processing):
// add their own tables, create lots with source_type HARVEST / PROCESSING /
// PURCHASE pointing at them (source_id), and add a PROCESSING transaction type
// plus a lot_links(parent_lot_id, child_lot_id, txn_id) table for genealogy.
// Nothing about the ledger, dispatch or barcode tables has to change.
// ─────────────────────────────────────────────────────────────────────────

export const orgs = sqliteTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address').notNull().default(''),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  labelWidthMm: integer('label_width_mm').notNull().default(100),
  labelHeightMm: integer('label_height_mm').notNull().default(75),
  createdAt: text('created_at').notNull().default(sql`(current_timestamp)`)
});

export const ROLES = ['admin', 'manager', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.id),
    // Sign-in name: email, phone or a short user ID. Unique across the deployment
    // so sign-in doesn't need an organisation picker.
    login: text('login').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    passwordHash: text('password_hash').notNull(),
    passwordSalt: text('password_salt').notNull(),
    disabledAt: text('disabled_at'),
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at').notNull().default(sql`(current_timestamp)`)
  },
  (t) => [uniqueIndex('users_login').on(t.login)]
);

// Godowns an operator may post stock in. Admins and managers are not restricted.
export const userGodowns = sqliteTable(
  'user_godowns',
  {
    userId: text('user_id').notNull().references(() => users.id),
    locationId: text('location_id').notNull().references(() => locations.id)
  },
  (t) => [primaryKey({ columns: [t.userId, t.locationId] })]
);

// Godowns today. parent_id + kind leave room for stacks/bays, or for estates,
// divisions and blocks as non-stock locations in a later phase.
export const locations = sqliteTable(
  'locations',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.id),
    parentId: text('parent_id'),
    kind: text('kind').notNull().default('GODOWN'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address').notNull().default(''),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(current_timestamp)`)
  },
  (t) => [uniqueIndex('locations_org_code').on(t.orgId, t.code)]
);

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    coffeeType: text('coffee_type').notNull().default(''), // Arabica / Robusta
    form: text('form').notNull().default(''), // Parchment / Cherry / Clean
    grade: text('grade').notNull().default(''),
    bagGrams: integer('bag_grams'), // standard bag weight, pre-fills kg from bags
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(current_timestamp)`)
  },
  (t) => [uniqueIndex('items_org_code').on(t.orgId, t.code)]
);

export const clients = sqliteTable(
  'clients',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    contactPerson: text('contact_person').notNull().default(''),
    phone: text('phone').notNull().default(''),
    address: text('address').notNull().default(''),
    gstin: text('gstin').notNull().default(''),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(current_timestamp)`)
  },
  (t) => [uniqueIndex('clients_org_code').on(t.orgId, t.code)]
);

export const LOT_SOURCES = ['RECEIPT', 'PURCHASE', 'HARVEST', 'PROCESSING'] as const;

export const lots = sqliteTable(
  'lots',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.id),
    code: text('code').notNull(),
    itemId: text('item_id').notNull().references(() => items.id),
    sourceType: text('source_type', { enum: LOT_SOURCES }).notNull().default('RECEIPT'),
    sourceId: text('source_id'), // row in a future source table (harvest intake, processing run …)
    sourceRef: text('source_ref').notNull().default(''),
    cropYear: text('crop_year').notNull().default(''),
    moisturePct: real('moisture_pct'),
    outturnPct: real('outturn_pct'),
    notes: text('notes').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(current_timestamp)`),
    createdBy: text('created_by')
  },
  (t) => [uniqueIndex('lots_org_code').on(t.orgId, t.code), index('lots_item').on(t.itemId)]
);

export const TXN_TYPES = ['OPENING', 'RECEIPT', 'TRANSFER', 'ADJUSTMENT', 'DISPATCH', 'REVERSAL'] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export const stockTxns = sqliteTable(
  'stock_txns',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.id),
    no: text('no').notNull(),
    type: text('type', { enum: TXN_TYPES }).notNull(),
    status: text('status', { enum: ['POSTED', 'REVERSED'] }).notNull().default('POSTED'),
    effectiveDate: text('effective_date').notNull(),
    postedAt: text('posted_at').notNull(),
    postedBy: text('posted_by').references(() => users.id),
    reference: text('reference').notNull().default(''),
    reason: text('reason').notNull().default(''),
    notes: text('notes').notNull().default(''),
    reversesId: text('reverses_id'),
    dispatchId: text('dispatch_id')
  },
  (t) => [
    uniqueIndex('stock_txns_org_no').on(t.orgId, t.no),
    // A transaction can be reversed only once.
    uniqueIndex('stock_txns_reverses').on(t.reversesId),
    index('stock_txns_org_posted').on(t.orgId, t.postedAt)
  ]
);

// Append-only. One signed row per godown + lot touched by a posted transaction.
export const stockLedger = sqliteTable(
  'stock_ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: text('org_id').notNull(),
    txnId: text('txn_id').notNull().references(() => stockTxns.id),
    locationId: text('location_id').notNull().references(() => locations.id),
    lotId: text('lot_id').notNull().references(() => lots.id),
    itemId: text('item_id').notNull().references(() => items.id),
    grams: integer('grams').notNull(),
    bags: integer('bags').notNull(),
    effectiveDate: text('effective_date').notNull()
  },
  (t) => [
    index('stock_ledger_balance').on(t.locationId, t.lotId),
    index('stock_ledger_lot').on(t.lotId),
    index('stock_ledger_txn').on(t.txnId),
    index('stock_ledger_org').on(t.orgId)
  ]
);

export const DISPATCH_STATUSES = ['DRAFT', 'DISPATCHED', 'CANCELLED', 'REVERSED'] as const;

export const dispatches = sqliteTable(
  'dispatches',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.id),
    no: text('no').notNull(),
    status: text('status', { enum: DISPATCH_STATUSES }).notNull().default('DRAFT'),
    clientId: text('client_id').notNull().references(() => clients.id),
    dispatchDate: text('dispatch_date').notNull(),
    destination: text('destination').notNull().default(''),
    vehicleNo: text('vehicle_no').notNull().default(''),
    transporter: text('transporter').notNull().default(''),
    driverName: text('driver_name').notNull().default(''),
    driverPhone: text('driver_phone').notNull().default(''),
    reference: text('reference').notNull().default(''),
    notes: text('notes').notNull().default(''),
    // Set when posted. Not a foreign key: it is written just before the stock
    // transaction row in the same batch, and a trigger checks they match.
    txnId: text('txn_id'),
    statusReason: text('status_reason').notNull().default(''),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by').references(() => users.id),
    updatedAt: text('updated_at').notNull(),
    postedAt: text('posted_at'),
    postedBy: text('posted_by').references(() => users.id),
    closedAt: text('closed_at') // cancelled or reversed
  },
  (t) => [uniqueIndex('dispatches_org_no').on(t.orgId, t.no), index('dispatches_org_status').on(t.orgId, t.status, t.createdAt)]
);

export const dispatchLines = sqliteTable(
  'dispatch_lines',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    dispatchId: text('dispatch_id').notNull().references(() => dispatches.id),
    lineNo: integer('line_no').notNull(),
    locationId: text('location_id').notNull().references(() => locations.id),
    lotId: text('lot_id').notNull().references(() => lots.id),
    itemId: text('item_id').notNull().references(() => items.id),
    grams: integer('grams').notNull(),
    bags: integer('bags').notNull(),
    packages: integer('packages').notNull(),
    // Editing a draft's lines supersedes the old ones (kept, because retired
    // packages still point at them). Only non-superseded lines count.
    supersededAt: text('superseded_at')
  },
  (t) => [index('dispatch_lines_dispatch').on(t.dispatchId), index('dispatch_lines_balance').on(t.locationId, t.lotId)]
);

export const PACKAGE_STATUSES = ['PREPARED', 'DISPATCHED', 'CANCELLED', 'RETURNED'] as const;

// One row per physical package. The barcode is unique for all time; retired
// packages keep their row (CANCELLED) so an old label still resolves.
export const dispatchPackages = sqliteTable(
  'dispatch_packages',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    dispatchId: text('dispatch_id').notNull().references(() => dispatches.id),
    lineId: text('line_id').notNull().references(() => dispatchLines.id),
    lotId: text('lot_id').notNull().references(() => lots.id),
    seq: integer('seq').notNull(),
    barcode: text('barcode').notNull(),
    grams: integer('grams').notNull(),
    bags: integer('bags').notNull(),
    status: text('status', { enum: PACKAGE_STATUSES }).notNull().default('PREPARED'),
    printCount: integer('print_count').notNull().default(0),
    createdAt: text('created_at').notNull(),
    dispatchedAt: text('dispatched_at'),
    cancelledAt: text('cancelled_at')
  },
  (t) => [uniqueIndex('dispatch_packages_barcode').on(t.barcode), index('dispatch_packages_dispatch').on(t.dispatchId)]
);

// Per-org document number sequences (RCV-2026, DSP-2026, LOT-2026 …).
export const counters = sqliteTable(
  'counters',
  {
    orgId: text('org_id').notNull(),
    key: text('key').notNull(),
    value: integer('value').notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })]
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    summary: text('summary').notNull().default(''),
    actorId: text('actor_id'),
    at: text('at').notNull().default(sql`(current_timestamp)`)
  },
  (t) => [index('audit_entity').on(t.orgId, t.entity, t.entityId, t.at)]
);
