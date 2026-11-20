/**
 * Database schema — see CAFE_POS_SPEC.md §6.
 * Money: *_millimes bigint (integers). Quantities: *_base bigint (mg | ml | pieces).
 * Timestamps: timestamptz (UTC). business_day: date in Africa/Tunis business terms.
 */
import {
  pgTable, uuid, text, timestamp, bigint, bigserial, integer, boolean, numeric, jsonb, date,
  primaryKey, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const big = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------- devices
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  status: text("status").notNull().default("active"), // active | revoked
  pairedAt: ts("paired_at"),
  lastSeenAt: ts("last_seen_at"),
  lastSyncAt: ts("last_sync_at"),
  lastClockOffsetMs: big("last_clock_offset_ms"),
  lastSeq: big("last_seq").notNull().default(0),
  lastHash: text("last_hash"),
  appVersion: text("app_version"),
  pendingReported: integer("pending_reported"),
});

export const pairingCodes = pgTable("pairing_codes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  codeHash: text("code_hash").notNull(),
  deviceName: text("device_name").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdBy: text("created_by"),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

// ---------------------------------------------------------------- admin auth
export const admins = pgTable("admins", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const adminSessions = pgTable("admin_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  adminId: big("admin_id").notNull().references(() => admins.id),
  stage: text("stage").notNull(), // 'totp' (password ok, waiting 2FA) | 'full'
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  ip: text("ip"),
});

export const loginAttempts = pgTable("login_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  key: text("key").notNull(), // 'email:<x>' or 'ip:<x>'
  success: boolean("success").notNull(),
}, (t) => [index("login_attempts_key_ts").on(t.key, t.ts)]);

// ---------------------------------------------------------------- catalogue
export const products = pgTable("products", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  nameAr: text("name_ar").notNull(),
  nameFr: text("name_fr"),
  category: text("category"),
  color: text("color"),
  image: text("image"), // e.g. /products/espresso.svg (served locally, cached offline on the tablet)
  sortOrder: integer("sort_order").default(0).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: ts("created_at").defaultNow().notNull(),
});

export const productPrices = pgTable("product_prices", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  productId: big("product_id").notNull().references(() => products.id),
  priceMillimes: big("price_millimes").notNull(),
  effectiveFrom: ts("effective_from").notNull(),
  createdBy: text("created_by"),
}, (t) => [index("product_prices_pid_eff").on(t.productId, t.effectiveFrom)]);

// ---------------------------------------------------------------- stock
export const stockItems = pgTable("stock_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  nameAr: text("name_ar").notNull(),
  kind: text("kind").notNull(), // weight (mg) | volume (ml) | piece
  qtyBase: big("qty_base").notNull().default(0),
  costPerBase: numeric("cost_per_base", { precision: 24, scale: 10 }).notNull().default("0"),
  minQtyBase: big("min_qty_base").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export const stockCostHistory = pgTable("stock_cost_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  stockItemId: big("stock_item_id").notNull().references(() => stockItems.id),
  costPerBase: numeric("cost_per_base", { precision: 24, scale: 10 }).notNull(),
  effectiveFrom: ts("effective_from").notNull(),
  purchaseMovementId: big("purchase_movement_id"),
}, (t) => [index("stock_cost_hist_item_eff").on(t.stockItemId, t.effectiveFrom)]);

export const recipeVersions = pgTable("recipe_versions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  productId: big("product_id").notNull().references(() => products.id),
  effectiveFrom: ts("effective_from").notNull(),
  createdBy: text("created_by"),
}, (t) => [index("recipe_versions_pid_eff").on(t.productId, t.effectiveFrom)]);

export const recipeLines = pgTable("recipe_lines", {
  recipeVersionId: big("recipe_version_id").notNull().references(() => recipeVersions.id),
  stockItemId: big("stock_item_id").notNull().references(() => stockItems.id),
  qtyBase: big("qty_base").notNull(), // nominal deducted per unit sold
  realQtyBase: numeric("real_qty_base", { precision: 18, scale: 3 }).notNull(), // real measured consumption per unit
}, (t) => [primaryKey({ columns: [t.recipeVersionId, t.stockItemId] })]);

export const stockMovements = pgTable("stock_movements", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: ts("ts").notNull(),
  stockItemId: big("stock_item_id").notNull().references(() => stockItems.id),
  deltaBase: big("delta_base").notNull(),
  type: text("type").notNull(), // sale|void|purchase|count_adjust|waste|staff_consumption|correction
  refType: text("ref_type"),
  refId: text("ref_id"),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("stock_movements_item_ts").on(t.stockItemId, t.ts), index("stock_movements_ref").on(t.refType, t.refId)]);

// ---------------------------------------------------------------- orders
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey(),
  deviceId: uuid("device_id").references(() => devices.id),
  deviceSeq: big("device_seq").notNull(),
  orderLabel: text("order_label").notNull(),
  clientTs: ts("client_ts").notNull(),
  effectiveTs: ts("effective_ts").notNull(),
  receivedAt: ts("received_at").notNull(),
  businessDay: date("business_day", { mode: "string" }).notNull(),
  shift: text("shift").notNull(), // morning | evening
  status: text("status").notNull().default("ok"), // ok | void | pending_review
  paymentType: text("payment_type").notNull(), // cash | ticket | pending (pay later, not yet paid) | loss (left without paying)
  paidAt: ts("paid_at"), // when the payment was taken (cash reconciliation uses the PAYMENT shift)
  paidBusinessDay: date("paid_business_day", { mode: "string" }),
  paidShift: text("paid_shift"),
  tableRef: text("table_ref"), // optional table / customer reference typed by the worker
  ticketId: uuid("ticket_id"),
  totalMillimes: big("total_millimes").notNull(),
  costMillimes: numeric("cost_millimes", { precision: 18, scale: 3 }).notNull(),
  flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
  voidReason: text("void_reason"),
  voidedBy: text("voided_by"),
  voidedAt: ts("voided_at"),
  reviewNote: text("review_note"),
}, (t) => [
  uniqueIndex("orders_device_seq").on(t.deviceId, t.deviceSeq),
  index("orders_day_shift").on(t.businessDay, t.shift),
  index("orders_effective").on(t.effectiveTs),
  index("orders_paid_day_shift").on(t.paidBusinessDay, t.paidShift),
]);

export const orderItems = pgTable("order_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  productId: big("product_id").notNull().references(() => products.id),
  qty: integer("qty").notNull(),
  unitPriceMillimes: big("unit_price_millimes").notNull(),
  unitCostMillimes: numeric("unit_cost_millimes", { precision: 18, scale: 3 }).notNull(),
  recipeVersionId: big("recipe_version_id"),
}, (t) => [index("order_items_order").on(t.orderId)]);

// ---------------------------------------------------------------- tickets & credit
export const customers = pgTable("customers", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  note: text("note"),
  lowTicketsThreshold: integer("low_tickets_threshold"),
  active: boolean("active").notNull().default(true),
});

export const ticketSheets = pgTable("ticket_sheets", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  customerId: big("customer_id").notNull().references(() => customers.id),
  type: text("type").notNull(), // free | credit
  ticketCount: integer("ticket_count").notNull(),
  maxAmountMillimes: big("max_amount_millimes"),
  issuedAt: ts("issued_at").notNull(),
  issuedBy: text("issued_by"),
  note: text("note"),
});

export const tickets = pgTable("tickets", {
  id: uuid("id").primaryKey(),
  sheetId: big("sheet_id").references(() => ticketSheets.id),
  tokenHash: text("token_hash").notNull().unique(),
  tokenEnc: text("token_enc"), // AES-GCM encrypted token so the Owner can (re)print the sheet; DB alone cannot reveal it
  shortCode: text("short_code").notNull().unique(),
  shortCodeHash: text("short_code_hash").notNull().unique(),
  type: text("type").notNull(), // free | credit
  customerId: big("customer_id").references(() => customers.id),
  customerName: text("customer_name").notNull(),
  maxAmountMillimes: big("max_amount_millimes"),
  status: text("status").notNull().default("issued"), // issued | used | void
  issuedAt: ts("issued_at").notNull(),
  issuedBy: text("issued_by"),
  note: text("note"),
  usedOrderId: uuid("used_order_id"),
  usedAt: ts("used_at"),
  usedDeviceId: uuid("used_device_id"),
}, (t) => [index("tickets_customer_status").on(t.customerId, t.status)]);

export const creditLedger = pgTable("credit_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  customerId: big("customer_id").notNull().references(() => customers.id),
  ts: ts("ts").notNull(),
  businessDay: date("business_day", { mode: "string" }).notNull(),
  type: text("type").notNull(), // charge | payment | adjustment
  amountMillimes: big("amount_millimes").notNull(), // charge: +debt ; payment: amount paid (positive) ; adjustment: signed debt change
  orderId: uuid("order_id"),
  ticketId: uuid("ticket_id"),
  note: text("note"),
  createdBy: text("created_by"),
});

// ---------------------------------------------------------------- responsibility, money, counts
export const roster = pgTable("roster", {
  businessDay: date("business_day", { mode: "string" }).notNull(),
  shift: text("shift").notNull(),
  workerName: text("worker_name").notNull(),
}, (t) => [primaryKey({ columns: [t.businessDay, t.shift] })]);

export const expenses = pgTable("expenses", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(), // fixed | variable
  category: text("category").notNull(),
  label: text("label").notNull(),
  amountMillimes: big("amount_millimes").notNull(),
  recurrence: text("recurrence").notNull(), // monthly | once
  startDay: date("start_day", { mode: "string" }).notNull(),
  endDay: date("end_day", { mode: "string" }),
  isPurchase: boolean("is_purchase").notNull().default(false),
  purchaseRef: big("purchase_ref"),
  paidFrom: text("paid_from").notNull().default("owner"), // drawer | owner
  paidAt: ts("paid_at"),
  invoiceRef: text("invoice_ref"),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const stockCounts = pgTable("stock_counts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: ts("ts").notNull(), // actual time of physical count
  enteredAt: ts("entered_at").notNull().defaultNow(),
  businessDay: date("business_day", { mode: "string" }).notNull(), // evaluated business day
  evaluatedShift: text("evaluated_shift").notNull(), // shift whose activity this count closes
  handover: text("handover").notNull(), // morning_to_evening | evening_to_morning | unannounced | weekly
  stockItemId: big("stock_item_id").notNull().references(() => stockItems.id),
  theoreticalBase: big("theoretical_base").notNull(),
  countedBase: big("counted_base").notNull(),
  varianceBase: big("variance_base").notNull(),
  expectedSurplusBase: numeric("expected_surplus_base", { precision: 18, scale: 3 }).notNull(),
  marginUsedPct: numeric("margin_used_pct", { precision: 10, scale: 2 }),
  valueMillimes: numeric("value_millimes", { precision: 18, scale: 3 }),
  unitsSold: big("units_sold").notNull().default(0),
  countedBy: text("counted_by"),
  note: text("note"),
}, (t) => [index("stock_counts_item_ts").on(t.stockItemId, t.ts)]);

export const cashCounts = pgTable("cash_counts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: ts("ts").notNull(),
  enteredAt: ts("entered_at").notNull().defaultNow(),
  businessDay: date("business_day", { mode: "string" }).notNull(),
  shift: text("shift").notNull(),
  expectedCashMillimes: big("expected_cash_millimes").notNull(),
  countedCashMillimes: big("counted_cash_millimes").notNull(),
  varianceMillimes: big("variance_millimes").notNull(),
  ticketsExpected: integer("tickets_expected").notNull(),
  ticketsInDrawer: integer("tickets_in_drawer").notNull(),
  countedBy: text("counted_by"),
  note: text("note"),
});

// ---------------------------------------------------------------- sync inbox, audit, alerts
export const syncEvents = pgTable("sync_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  deviceId: uuid("device_id"),
  seq: big("seq").notNull(),
  clientEventId: uuid("client_event_id").notNull().unique(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  prevHash: text("prev_hash"),
  hash: text("hash").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
  status: text("status").notNull().default("accepted"), // accepted | rejected
  reason: text("reason"),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity"),
  entityId: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: text("ip"),
}, (t) => [index("audit_ts").on(t.ts)]);

export const alerts = pgTable("alerts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  severity: text("severity").notNull(), // info | warn | critical
  type: text("type").notNull(),
  ref: text("ref"),
  dedupeKey: text("dedupe_key"),
  businessDay: date("business_day", { mode: "string" }),
  shift: text("shift"),
  message: text("message").notNull(),
  acknowledgedBy: text("acknowledged_by"),
  acknowledgedAt: ts("acknowledged_at"),
  resolvedAt: ts("resolved_at"),
}, (t) => [index("alerts_dedupe").on(t.dedupeKey), index("alerts_ts").on(t.ts)]);
