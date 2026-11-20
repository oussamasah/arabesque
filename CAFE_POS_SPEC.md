# CAFE_POS_SPEC.md — Café Management & Anti-Theft POS (Tunisia)

> **Audience:** an AI coding agent (and human reviewers) that will design, build, test and maintain this system.
> **Status:** design specification v1.1 — Owner decisions of 2026-11-20 integrated (see §17). No production code exists yet.
> **Owner/Product decision-maker:** the café owner ("Owner"). He is also a senior full-stack engineer, so technical questions can be asked directly, but UX for café staff must be usable by non-technical people.
> **Primary UI language:** Arabic (Tunisian context), RTL. French optional later. This document is in English for precision; UI strings are given in Arabic where it matters (§10, §17).

---

## 0. How to use this document (rules for the agent)

1. **This document is the source of truth.** If code and spec disagree, the spec wins unless the Owner says otherwise. If the spec is ambiguous or contradicts itself, **ask the Owner** (short, concrete question with a recommended default) instead of guessing. Items marked **[ASSUMPTION]** are decisions that were never explicitly confirmed: implement them as configurable defaults and list them in the PR/summary for confirmation.
2. **Never weaken an anti-fraud invariant (§3) for convenience.** If a feature request or an implementation shortcut would break one, stop and flag it.
3. **Do not invent features.** Build the phases in §16 in order. Anything not in this spec goes to the backlog list, not into the code.
4. **Money and quantities are integers** (§3, rule 5). Never use floating point for money or stock quantities.
5. **No hard deletes, no silent edits** of business records. Everything is append-only or voided with audit (§3).
6. Write tests for every business rule in §7 (see §16 for the required test list). A rule without a test is not done.
7. When finishing a task, report: what was built, what was tested, which [ASSUMPTION]s were used, and what remains.

---

## 1. Product summary

A point-of-sale and management system for **one café in Tunisia** that sells coffee, shisha (water-pipe), water, soft drinks and other items sold per piece.

**Main purpose (in priority order):**
1. **Reduce theft and make accounting exact.** The system's job is to make theft *detectable, attributable to a shift, and measurable in dinars*, and to act as a deterrent. It does **not** claim to prevent theft; it detects and deters.
2. Record every order quickly on a wall-mounted tablet, even with **no internet**.
3. Give the Owner a clear picture of stock, costs, profit (daily / weekly / monthly) and per-product profitability.

**Scale:** one café, **one tablet** (design for N devices but ship with 1), one Owner (admin), several workers who share the tablet (no personal logins — see §4).

---

## 2. Business context & constants

| Item | Value |
|---|---|
| Country / currency | Tunisia — Tunisian Dinar (TND/DT). **1 DT = 1000 millimes.** Store **millimes as integers**; display with 3 decimals (e.g. `1.800 DT`). |
| Time zone | `Africa/Tunis` (UTC+1, currently no DST — always use the IANA zone, never a fixed offset). |
| Shifts | **Morning:** 06:00 → 15:00. **Evening:** 15:00 → 06:00 (next calendar day). Both boundaries are **settings** (default 6 and 15). |
| Business day | Starts at the morning-shift start (06:00). An order at 02:00 on Tue belongs to **Monday's** business day, evening shift. |
| Week | Monday → Sunday (**confirmed**). |
| Products (examples) | Coffee in several types (إكسبراس express, كابوسان capucin, …), Tea (شاي), Shisha: **Jirak big** (جيراك كبير), **Jirak small** (جيراك صغير), **Flavored shisha** (شيشة معطرة, one size); Croissant (كرواسون), Juice (عصير), Water (ماء), Soft drinks (قزوز), other items. The Owner can **add new products at any time**. Owner defines the real catalogue and prices. |
| Stock units | Weight items in **milligrams** (coffee, jirak, flavored tobacco, sugar, …), volume/other bulk items in a base unit chosen per item, piece items in **pieces**. **Every consumable is tracked** (coffee, milk, sugar, tea, charcoal, tobacco, drinks, croissants, …) via recipes. |
| Yields (all **editable by the Owner in admin**) | Nothing is hard-coded: for each product/stock item the Owner enters the **accounted yield** (units per kg used for deduction) and the **real yield** (measured). Initial values: **Coffee:** accounted **80 cups/kg**, real ~**90**. **Jirak:** accounted **15 shishas/kg**, real **16** (Owner measured 15–16). **Flavored shisha:** Owner will measure and enter. Big vs small jirak = two products with different recipes. Water, soda and other piece items: **no margin**. |
| Staff/customer context | Workers are non-technical. Customers include people who take items **free** or on **credit**; these are handled with printed QR tickets (§7.6). |

---

## 3. Non-negotiable invariants (anti-fraud & integrity)

1. **Blind worker screen.** The worker UI never shows prices, order totals, stock levels, ticket values or reports. It shows only products, quantities and generic confirmation. (Reason: the Owner does not want workers to compute a total and decide which orders to leave unrecorded so that cash "matches" a displayed total.)
2. **Server computes everything monetary.** Prices live on the server. The tablet does **not even store prices**. Totals, costs, stock deduction are computed server-side at sync time using the price/recipe versions valid at the order's effective time.
3. **Append-only events.** The tablet can only *create* order events. It cannot edit or delete orders. Corrections (void) are **admin-only**, server-side, and audited.
4. **Per-device sequence + hash chain.** Every event from a device carries a gap-free sequence number (`T1-0001, T1-0002…`) and `hash = sha256(prev_hash || canonical_payload)`. The server rejects/flags gaps, duplicates and broken chains (detects deleted or altered local records).
5. **Integers only.** Money in millimes (`bigint`), weights in mg (`bigint`), pieces as integers. Costs per base unit may be `numeric` but results are rounded explicitly and consistently (round half up, once, at line level).
6. **Server-authoritative time.** Shift and business day are **pure functions of the (corrected) timestamp**, never selected by a user and never cron-driven. Device clock skew is measured and corrected (§8.5).
7. **No hard deletes.** Records are voided/deactivated; every admin mutation is written to `audit_log` with before/after.
8. **Snapshots.** `order_items` store the unit price and unit cost used at the time of sale, so later price/recipe edits never rewrite history.
9. **Idempotency.** Every client event has a UUID (`client_event_id`); re-sending must never double-count.
10. **Tickets are single-use, unguessable and admin-issued.** Workers can never create tickets or mark orders free/credit without a valid ticket (§7.6).
11. **The worker app cannot be exited or tampered with** except via the device-local kiosk admin code (§13), which is separate from the web admin login.
12. **Detect, don't accuse.** Alerts show *patterns* (repeat over shifts) and monetary size. A single variance is a signal, not proof. The UI must word alerts neutrally.

---

## 4. Actors & permissions

There are **no per-worker accounts**. Accountability is **per shift**, and the Owner assigns the responsible person to each shift in the admin (retroactively editable, audited). This is an explicit Owner decision.

**Staffing (confirmed):** 4 workers in total; in each shift (morning / evening) **one** worker uses and is responsible for the tablet — that person is the shift's roster entry.
**Trusted counter (confirmed):** a trusted person (not the shift worker) does the physical counts. This person has **no system access**: they write the remaining stock (and cash / ticket papers) on paper with the time of the count; the **Owner enters it in admin** and the system computes the variances.

| Capability | Worker (tablet, no login) | Owner/Admin (web, password + 2FA) | System |
|---|---|---|---|
| Create order (cash / ticket) | ✅ | ✅ (manual entry, audited) | — |
| See prices, totals, stock, reports | ❌ | ✅ | — |
| Cancel/void an order | ❌ | ✅ (reason required) | — |
| Create/print tickets | ❌ | ✅ | — |
| Scan/enter ticket to pay | ✅ | — | validates |
| Manage products, prices, recipes | ❌ | ✅ | versions |
| Record purchases, counts, waste | ❌ | ✅ | — |
| Assign worker to shift | ❌ | ✅ | defaults |
| Expenses (fixed/variable) | ❌ | ✅ | prorates |
| Pair/revoke tablets | ❌ | ✅ | — |
| Exit kiosk app | ❌ (needs kiosk admin code) | ✅ (kiosk code) | — |
| See sync/offline status | ✅ (icon + pending count only) | ✅ (full) | — |

---

## 5. Architecture

```
┌────────────────────────┐        HTTPS         ┌───────────────────────────┐
│ Android tablet (wall)  │  ───────────────►    │ Server: Next.js (Vercel   │
│ Fully Kiosk Browser    │   sync push/pull     │ or VPS), API routes       │
│  └ PWA "worker app"    │  ◄───────────────    │  └ Postgres (Neon/        │
│     IndexedDB + outbox │                      │    Supabase, EU region)   │
│     QR scan via camera │                      └─────────────┬─────────────┘
└────────────────────────┘                                    │
                                                  Admin web app (same Next.js)
                                                  Owner's phone/PC, 2FA login
Separate: CCTV camera (not part of the software)  ·  optional daily Telegram report
```

**Decisions (and why):**
- **Offline-first PWA inside Fully Kiosk Browser.** Internet outages are expected; **nothing may be lost** and ordering never blocks. Fully Kiosk gives kiosk lock, exit by admin PIN, auto-start, remote admin; HTTPS gives camera access for QR scanning.
- **Server: Next.js (App Router) + TypeScript + Postgres** (Neon or Supabase, **EU region**, point-in-time recovery enabled). SQLite/file storage is **not** usable on serverless.
- **Hosting caveat:** the Owner plans Vercel. As far as known, Vercel's free Hobby plan is for non-commercial use, so a café needs a paid plan (verify the current terms); alternatively a small VPS. Keep the code host-agnostic (plain Next.js + Postgres + env vars).
- **One tablet now**, but model `device_id` everywhere.
- **Surveillance camera is separate** hardware (not the POS tablet's camera) and must be **visible with signage and staff informed**. The software only needs timestamps that line up with video (§12).
- **Confirmed stack:** single Next.js app (worker PWA + admin), **Drizzle** ORM, **Neon** Postgres (EU). Git repository/GitHub: later (Owner decision).
- Suggested libs: Drizzle (Postgres), Zod validation, `idb` (IndexedDB), `zxing-wasm` or `BarcodeDetector` with fallback for QR, `otplib` for TOTP, `@react-pdf/renderer` or HTML-to-print for tickets, Vitest + Playwright.

---

## 6. Data model (PostgreSQL)

All `*_millimes` = `bigint`. All `*_base` quantities = `bigint` (mg for weight, pieces for piece items). Timestamps are `timestamptz` (UTC). `business_day` is a `date` in Tunis terms.

```sql
-- Devices (tablets)
CREATE TABLE devices (
  id uuid PRIMARY KEY, name text NOT NULL, key_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',          -- active | revoked
  paired_at timestamptz, last_seen_at timestamptz, last_sync_at timestamptz,
  last_clock_offset_ms bigint
);

CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
-- keys: morning_start_hour(6), evening_start_hour(15), default_worker_morning,
-- default_worker_evening, alert_thresholds{...}, week_start('monday'), business_name, tz

-- Catalogue
CREATE TABLE products (
  id bigserial PRIMARY KEY, name_ar text NOT NULL, name_fr text, category text,
  color text, sort_order int DEFAULT 0, active boolean DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE product_prices (            -- price history; effective_from is inclusive
  id bigserial PRIMARY KEY, product_id bigint REFERENCES products(id),
  price_millimes bigint NOT NULL CHECK (price_millimes >= 0), effective_from timestamptz NOT NULL);

-- Stock
CREATE TABLE stock_items (
  id bigserial PRIMARY KEY, name_ar text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('weight','piece')),
  qty_base bigint NOT NULL DEFAULT 0,        -- theoretical quantity (cache of movements)
  cost_per_base numeric(18,6) NOT NULL DEFAULT 0,   -- current weighted average, millimes per base unit (cache)
  min_qty_base bigint DEFAULT 0,             -- low-stock alert threshold, set by Owner per item
  active boolean DEFAULT true);
CREATE TABLE stock_cost_history (            -- weighted-average cost after each purchase; sales use the row valid at effective_ts
  id bigserial PRIMARY KEY, stock_item_id bigint REFERENCES stock_items(id),
  cost_per_base numeric(18,6) NOT NULL, effective_from timestamptz NOT NULL, purchase_movement_id bigint);

-- Recipes are versioned. A product consumes stock via its current recipe version.
CREATE TABLE recipe_versions (
  id bigserial PRIMARY KEY, product_id bigint REFERENCES products(id),
  effective_from timestamptz NOT NULL, created_by text);
CREATE TABLE recipe_lines (
  recipe_version_id bigint REFERENCES recipe_versions(id),
  stock_item_id bigint REFERENCES stock_items(id),
  qty_base bigint NOT NULL,          -- NOMINAL quantity deducted per unit sold (e.g. coffee 12500 mg)
  real_qty_base numeric(18,3) NOT NULL, -- REAL measured consumption per unit (e.g. coffee ≈ 11111.111 mg)
  PRIMARY KEY (recipe_version_id, stock_item_id));
-- margin_per_unit = qty_base - real_qty_base  (>= 0). For piece items real = nominal (no margin).
-- Admin UI lets the Owner enter either grams per unit or "units per kg" (accounted and real);
-- the server converts to qty_base / real_qty_base. All values are editable; each save = new version.

CREATE TABLE stock_movements (       -- immutable ledger; stock_items.qty_base is derived from it
  id bigserial PRIMARY KEY, ts timestamptz NOT NULL, stock_item_id bigint REFERENCES stock_items(id),
  delta_base bigint NOT NULL,
  type text NOT NULL CHECK (type IN ('sale','void','purchase','count_adjust','waste','staff_consumption','correction')),
  ref_type text, ref_id text, note text, created_by text);

-- Orders (id = client_event_id so retries are idempotent)
CREATE TABLE orders (
  id uuid PRIMARY KEY, device_id uuid REFERENCES devices(id), device_seq bigint NOT NULL,
  order_label text NOT NULL,                       -- e.g. 'T1-0045'
  client_ts timestamptz NOT NULL, effective_ts timestamptz NOT NULL, received_at timestamptz NOT NULL,
  business_day date NOT NULL, shift text NOT NULL CHECK (shift IN ('morning','evening')),
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','void','pending_review')),
  payment_type text NOT NULL CHECK (payment_type IN ('cash','ticket')),
  ticket_id uuid, total_millimes bigint NOT NULL, cost_millimes numeric(18,3) NOT NULL,
  flags text[] DEFAULT '{}',                       -- e.g. late_sync, clock_skew, ticket_conflict, over_ticket_limit
  void_reason text, voided_by text, voided_at timestamptz,
  UNIQUE (device_id, device_seq));
CREATE TABLE order_items (
  id bigserial PRIMARY KEY, order_id uuid REFERENCES orders(id), product_id bigint REFERENCES products(id),
  qty int NOT NULL CHECK (qty BETWEEN 1 AND 99),
  unit_price_millimes bigint NOT NULL, unit_cost_millimes numeric(18,3) NOT NULL,
  recipe_version_id bigint);

-- Tickets (free / credit), printed as QR
CREATE TABLE customers (id bigserial PRIMARY KEY, name text NOT NULL, phone text, note text,
  low_tickets_threshold int);                             -- NULL = use settings.low_tickets_threshold (default 5)
CREATE TABLE ticket_sheets (   -- one printed sheet = many single-use tickets for one customer (e.g. ~1 month)
  id bigserial PRIMARY KEY, customer_id bigint REFERENCES customers(id), type text NOT NULL CHECK (type IN ('free','credit')),
  ticket_count int NOT NULL CHECK (ticket_count BETWEEN 1 AND 200), issued_at timestamptz NOT NULL, issued_by text, note text);
CREATE TABLE tickets (
  id uuid PRIMARY KEY, sheet_id bigint REFERENCES ticket_sheets(id),
  token_hash text UNIQUE NOT NULL,                        -- sha256 of the 128-bit random token in the QR
  short_code text UNIQUE NOT NULL,                        -- e.g. 8 chars Crockford base32, printed under QR
  type text NOT NULL CHECK (type IN ('free','credit')),
  customer_id bigint REFERENCES customers(id), customer_name text NOT NULL,
  max_amount_millimes bigint,                             -- optional cap (NULL = none) [ASSUMPTION: optional]
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','used','void')),
  issued_at timestamptz NOT NULL, issued_by text, note text,
  used_order_id uuid, used_at timestamptz, used_device_id uuid);
CREATE TABLE credit_ledger (   -- customer debt
  id bigserial PRIMARY KEY, customer_id bigint REFERENCES customers(id), ts timestamptz NOT NULL,
  type text NOT NULL CHECK (type IN ('charge','payment','adjustment')),
  amount_millimes bigint NOT NULL, order_id uuid, ticket_id uuid, note text, created_by text);

-- Responsibility, money, counts
CREATE TABLE roster (business_day date, shift text, worker_name text NOT NULL, PRIMARY KEY (business_day, shift));
CREATE TABLE expenses (
  id bigserial PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('fixed','variable')),
  category text NOT NULL, label text NOT NULL, amount_millimes bigint NOT NULL,
  recurrence text NOT NULL CHECK (recurrence IN ('monthly','once')),
  start_day date NOT NULL, end_day date, is_purchase boolean DEFAULT false, purchase_ref bigint,
  paid_from text NOT NULL DEFAULT 'owner' CHECK (paid_from IN ('drawer','owner')),  -- drawer = paid from the shift's cash
  paid_at timestamptz,                       -- required when paid_from='drawer'; its shift is shiftInfo(paid_at)
  invoice_ref text,                          -- drawer expenses must match a purchase invoice
  created_by text);
CREATE TABLE stock_counts (   -- ts = ACTUAL time of the physical count (from the paper), entered_at = when Owner typed it
  id bigserial PRIMARY KEY, ts timestamptz NOT NULL, entered_at timestamptz NOT NULL DEFAULT now(),
  business_day date NOT NULL, handover text,  -- 'morning_to_evening' | 'evening_to_morning' | 'unannounced' | 'weekly'
  stock_item_id bigint REFERENCES stock_items(id),
  theoretical_base bigint NOT NULL, counted_base bigint NOT NULL, variance_base bigint NOT NULL,
  expected_surplus_base numeric(18,3) NOT NULL,   -- maximum surplus explained by the margin since previous count
  margin_used_pct numeric(8,2),                   -- see §7.4
  value_millimes numeric(18,3),                   -- variance valued at cost
  counted_by text, note text);
CREATE TABLE cash_counts (    -- ts = actual count time (paper), entered by Owner
  id bigserial PRIMARY KEY, ts timestamptz NOT NULL, entered_at timestamptz NOT NULL DEFAULT now(),
  business_day date NOT NULL, shift text NOT NULL,
  expected_cash_millimes bigint NOT NULL, counted_cash_millimes bigint NOT NULL, variance_millimes bigint NOT NULL,
  tickets_expected int NOT NULL, tickets_in_drawer int NOT NULL, counted_by text, note text);

-- Raw sync inbox + audit + alerts
CREATE TABLE sync_events (
  id bigserial PRIMARY KEY, device_id uuid, seq bigint NOT NULL, client_event_id uuid UNIQUE NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, prev_hash text, hash text NOT NULL,
  received_at timestamptz DEFAULT now(), status text NOT NULL DEFAULT 'accepted');
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), actor text NOT NULL, action text NOT NULL,
  entity text, entity_id text, before jsonb, after jsonb, ip inet);
CREATE TABLE alerts (
  id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), severity text NOT NULL,  -- info|warn|critical
  type text NOT NULL, ref text, message text NOT NULL, acknowledged_by text, acknowledged_at timestamptz);
```

---

## 7. Business rules

### 7.1 Business day & shift
```
shiftInfo(ts, morningStart=6, eveningStart=15):
  p = parts(ts in Africa/Tunis)            # y,m,d,hour
  day = date(p)
  if p.hour < morningStart: day = day - 1  # night belongs to previous business day
  shift = 'morning' if morningStart <= p.hour < eveningStart else 'evening'
  return (day, shift)
```
Boundary tests (required): 05:59→(prev day, evening); 06:00→(day, morning); 14:59→morning; 15:00→evening; 23:59→evening same day; 00:30→(prev day, evening).
**Responsible person:** looked up from `roster(business_day, shift)`, falling back to `settings.default_worker_<shift>`. It is **not** stored on the order; it is joined at report time so the Owner can fix it retroactively.

### 7.2 Orders
1. Worker taps products to build an order (qty 1–99 per product; max 60 distinct lines).
2. Worker confirms and picks the payment type: **Cash** or **Ticket**.
3. Locally the tablet records an event (§8). On sync the server: validates, resolves effective time, computes `total` (price version valid at `effective_ts`), per-line `unit_cost` (recipe version valid at `effective_ts` × `stock_cost_history` cost valid at `effective_ts` — **confirmed**: same time rule as prices, so late syncs are costed correctly), writes `orders`, `order_items`, and one `stock_movements` row **per stock item per order** (negative `delta_base` = nominal qty × units).
4. **Stock decreases automatically** with every synced order, for every stock item in the product's recipe (e.g. one capucin deducts coffee + milk + sugar; one big jirak deducts jirak + charcoal). Stock may go negative (never block a sale); negative stock raises an alert. When an item falls **below its `min_qty_base`** a `low_stock` alert ("يجب الشراء") is raised for the Owner. **Early warning (confirmed):** the system also estimates **days of stock left** = theoretical qty ÷ average daily consumption over the last `consumption_window_days` (setting, default 7 business days); when it is ≤ `reorder_days_ahead` (setting, default 3 days) a `stock_running_out` alert ("المخزون سينفد خلال N أيام") is raised, so the Owner buys **before** the item runs out. Workers never see stock or these alerts.
5. Display label for the worker after confirmation: `Order T1-0045 ✓` (no amount).

### 7.2b Pay later (confirmed by the Owner)
Customers usually pay when they leave. The worker records each round **when it is served** and chooses **"الدفع لاحقاً"** (optionally typing a table / customer reference). The tablet keeps a list **"غير مدفوعة"** (unpaid orders: reference, time, items — **never amounts**) with a **[دفع]** button per order → **كاش** or **تذكرة**.
- Two event types in the same per-device sequence/hash chain: `order.create` (`payment: cash | ticket | later`) and `order.pay` (`order_id`, `payment: cash | ticket`).
- **Stock, cost, order counts** belong to the shift that **served** the order (`effective_ts`). **Cash and ticket reconciliation** belong to the shift that **took the payment** (`paid_at`, `paid_business_day`, `paid_shift`), so a customer sitting across 15:00 does not create a false variance. Flag `paid_other_shift`.
- One ticket still pays one order; ticket single-use / conflict / cap rules apply at payment time. Credit is charged at payment.
- A second payment of the same order is rejected (`double_payment` alert); paying a voided order is rejected (`pay_after_void`).
- Alerts: order unpaid for more than `unpaid_alert_hours` (default 3 h), and a shift that ended with unpaid orders. Unpaid orders add to the shift risk score.
- **Responsibility (confirmed by the Owner): the worker of the SERVING shift is responsible for its unpaid orders.** Every order of a shift that is still unpaid, or whose customer left without paying, is shown as **owed by the worker** ("على العامل": value + count) on the cash count, the shift table, alerts and the daily report, until it is paid. If the customer pays later (even in another shift) the debt disappears automatically.
- Owner actions on an unpaid order: **record payment** — into the shift drawer, paid by the customer directly to the Owner, or **paid by the worker** (`paid_by_worker`; revenue, but not in the drawer) — **left without paying** (`payment_type = loss`: stock stays deducted, still owed by the worker until he pays), or **void**. The tablet's list follows the server (`open_orders` in the device config).
- Tablet: the unpaid list is a **full-screen grid** (many orders at once) with search by table/name; orders from a previous shift are marked "شيفت سابق — على العامل".

### 7.3 Stock, recipes, units
- Weight items in mg, pieces in pieces. Owner enters kg/g in the UI; the server converts.
- **All yields and quantities are Owner-editable in admin**; the computation always uses what the Owner recorded (versioned). Nothing is hard-coded.
- **Coffee example:** nominal 80 cups/kg ⇒ `qty_base = 12500 mg` deducted per cup; real 90 cups/kg ⇒ `real_qty_base = 11111.111 mg`. **Jirak (confirmed):** nominal 15 shishas/kg ⇒ `qty_base = 66667 mg` (rounded half up); real 16/kg ⇒ `real_qty_base = 62500 mg`. Big and small jirak are separate products with their own quantities. **Flavored shisha:** yield measured and entered by the Owner. Other coffee types, tea, juice, etc. get their own recipes (any number of stock lines).
- **Purchases (admin):** `qty`, `total price`, `invoice_ref`, `paid_from` (`drawer` | `owner`) and, for drawer payments, the time paid → stock movement `purchase` (+), update `cost_per_base` by weighted average (`max(old_qty,0)` used in the average) and append a `stock_cost_history` row, and auto-create a variable expense (`is_purchase=true`, same `paid_from`). Receipts should be counted at delivery before entry.
- **Waste** and **staff consumption** are admin-recorded movements (negative) with a note; they are *explained* losses.
- Stock quantities are always `SUM(stock_movements)`; `stock_items.qty_base` is a cache updated transactionally.

### 7.4 Stock counts & margin analysis (the core anti-theft metric)
Counts are done by the **Owner or a trusted person other than the counted shift's worker**, at **every shift handover** (06:00 and 15:00) for high-value items (coffee, jirak, water, sodas, other piece items), plus **unannounced** counts and a weekly full count.
**Workflow (confirmed):** the trusted person writes the remaining quantities and the **time of the count** on paper; the Owner enters them in admin with that actual time. `theoretical` is computed **at the count's `ts`**, not at entry time, so sales made between the count and its entry are not mixed in. Each count produces, per item:

```
theoretical      = system quantity at count time
counted          = physical quantity entered
variance         = counted - theoretical                  # negative = missing, positive = surplus
units_sold       = Σ units sold since previous count (for products consuming this item)
expected_surplus = Σ over those sales of (nominal_qty - real_qty)   # surplus explained by the margin
margin_used_pct  = (expected_surplus - variance) / expected_surplus * 100     # if expected_surplus > 0
value            = variance * cost_per_base               # in millimes, shown in DT
```
Interpretation (shown plainly in the UI):
- `variance ≈ expected_surplus` → margin 0% used: everything is accounted for.
- `variance = 0` → margin 100% used: all margin consumed (spill, staff drinks… **or unrecorded sales**).
- `variance < 0` → margin >100%: loss beyond the margin → **alert**.
- Honest operation yields a *varying* margin-used percentage; **a shift that sits near ≥90% repeatedly** while others sit lower is a pattern alert.
- Piece items (water, sodas…) have **no margin**: any negative variance alerts immediately.
After a count, the system books a `count_adjust` movement so theoretical = counted, and stores the `stock_counts` row.
Default alert thresholds (settings, editable): margin_used ≥ 100% (critical), ≥ 90% for 3 consecutive shifts (warn), any negative variance on piece items (warn), variance value ≥ configurable DT amount (critical).

### 7.5 Cash reconciliation (per shift handover)
```
expected_cash = Σ total of 'cash' orders in the shift  -  Σ expenses with paid_from='drawer' whose paid_at falls in the shift
tickets_expected = number of 'ticket' orders in the shift
```
- Every drawer expense must match a **purchase invoice** (`invoice_ref`); the invoice paper is left in the drawer and the Owner records it. Expenses paid from the Owner's own money (`paid_from='owner'`) do **not** affect the drawer.
- **Credit repayments go directly to the Owner** and never enter a shift's drawer or `expected_cash`.
Counting (written on paper by the trusted person, entered by the Owner with the actual count time): `counted_cash` and `tickets_in_drawer` (physical paper tickets). Differences are stored and alerted: cash variance ≠ 0, `tickets_in_drawer ≠ tickets_expected`. (Cash alone is **not** sufficient to detect unrecorded sales — a worker can pocket exactly the unrecorded amount. Stock counts are the primary control; cash is secondary.)

### 7.6 Tickets (free & credit)
Purpose: customers who take items free or on credit hand over a **printed paper ticket with a QR code** instead of money; the paper goes into the cash drawer **in place of the money**, so cash + tickets reconcile.
- **Ticket sheets (confirmed):** the Owner prints for a customer a **sheet of many tickets** (e.g. enough for about a month). Each ticket = **one order, one use**. Tickets have **no expiry date** while unused. When a customer's remaining unused tickets reach `low_tickets_threshold` (setting, default 5, overridable per customer) a `low_tickets` alert is raised so the Owner prints a new sheet; the customer is expected to ask for one before running out. **If the customer has no ticket left, he/she pays cash** (process rule — the tablet simply has no valid ticket to scan).
- **Issuing:** Owner only, in admin. Choose type (`free` | `credit`), customer (link to `customers`), number of tickets in the sheet, optional `max_amount` per ticket (**confirmed optional**, default none), note. The system generates a **128-bit random token** (QR content = `https://<host>/t/<token>` or just the token) and a short code; only `sha256(token)` is stored. The printable ticket shows: business name, customer name, type label, short code, QR, ticket id. **QR content must be unguessable — never a sequential number or the customer's name.**
- **Using:** worker selects "Ticket", scans the QR with the tablet camera (or types the short code). Validation (online: server; offline: against the cached list of valid token hashes): exists, status `issued`, not already used. The worker sees only ✓/✗ with a generic message — never the amount or customer.
- **Single use.** After use, status `used` with `used_order_id`, time, device. A second use is rejected and raises a `ticket_reuse_attempt` alert.
- **Offline conflict:** if two offline uses of the same ticket are synced later, the first (by effective time) wins; the other order becomes `pending_review` with flag `ticket_conflict` and an alert.
- **Cap:** if `max_amount` is set and the computed order total exceeds it, the order is accepted but flagged `over_ticket_limit` and goes to `pending_review` (the worker is never shown amounts, so rejection happens server-side after the fact).
- **Accounting:**
  - `free` ticket order → revenue 0; cost of goods is a **loss** (shown as "free giveaways").
  - `credit` ticket order → revenue 0 for now; `credit_ledger` `charge` for the customer. When the customer pays (**the money goes directly to the Owner**, who records the repayment in admin — **confirmed**) → ledger `payment`, and the amount counts as cash revenue **on the repayment day**. It is not part of any shift's drawer.
- **Physical reconciliation:** each shift, the number of paper tickets in the drawer must equal the number of ticket orders; admin shows the list (ticket id, customer, type, order label, amount) for checking.

### 7.7 Voids / corrections
Admin only. Requires a reason. Sets order `void`, reverses its stock movements (`void` type), re-opens the ticket if any (and reverses credit charge), writes audit. Voids are listed per shift (counts feed the risk score).

### 7.8 Finance & profit
Ranges are by `business_day`. Definitions (display both; the Owner's own description is the cash view):
```
revenue_cash       = Σ total of ok orders with payment_type='cash'  +  credit repayments received in range
purchases          = Σ variable expenses where is_purchase = true
other_variable     = Σ variable expenses where is_purchase = false
fixed_prorated     = for each day in range, for each active fixed expense:  amount / days_in_that_month
free_giveaways     = Σ cost of ok orders paid by 'free' tickets  (and 'credit' not yet repaid shown separately)
profit_cash        = revenue_cash - purchases - other_variable - fixed_prorated        # Owner's view
cogs               = Σ cost_millimes of ok orders (recipe-based)
profit_consumption = revenue_cash - cogs - other_variable - fixed_prorated            # avoids purchase timing effects
```
Report slices: today / current week / current month / custom range; **by shift** (with assigned worker); credit outstanding per customer.

### 7.9 Statistics (admin)
Per product: units, paid units, free/credit units, revenue, cost, profit, unit margin; **loss-making products flagged**. Best/worst sellers; sales by hour (Tunis time); by shift and by assigned worker (orders, voids, tickets, margin used, cash variance); credit aging.

### 7.10 Alerts & shift risk score
Alert types: low stock (below `min_qty_base`), low remaining tickets for a customer, negative variance, margin ≥ thresholds, repeated high margin use, cash variance, ticket count mismatch, ticket reuse attempt, ticket conflict, over-ticket-limit, void spikes, sequence gap, broken hash chain, device not synced > X hours, no orders during expected busy hours, large clock skew, negative stock.
**Risk score per shift** (green/yellow/red) = weighted sum of the above with configurable weights; displayed on the dashboard and in the daily report. Wording is neutral ("needs review"), never "theft".
**Daily report (Phase 2):** summary + alerts sent to the Owner via Telegram (bot token in env) or email.

---

## 8. Offline-first sync design

### 8.1 Tablet local storage (IndexedDB)
Stores: `config` (products without prices, shift settings, config version), `valid_tickets` (token hashes of `issued` tickets), `events` (append-only outbox + permanent local log), `meta` (device id, device key, next seq, last hash, clock offset). On startup call `navigator.storage.persist()`. Keep sent events locally for **30 days** as an extra backup; never delete unsent events.

### 8.2 Event envelope
```json
{ "client_event_id": "uuid-v4", "device_id": "uuid", "seq": 45, "type": "order.create",
  "client_ts": 1700000000000, "clock_offset_ms": -1200,
  "payload": { "items": [{"product_id": 3, "qty": 2}], "payment": "cash|ticket", "ticket_token_hash": "…" },
  "prev_hash": "…", "hash": "sha256(prev_hash || canonical_json(envelope without 'hash'))" }
```
**Hash coverage (confirmed):** the hash covers **every envelope field except `hash` itself** — `client_event_id`, `device_id`, `seq`, `type`, `client_ts`, `clock_offset_ms`, `payload`, `prev_hash` — using a deterministic canonical JSON (sorted keys, no whitespace).
`order_label` = `<device_name>-<seq zero-padded>`. Event types in v1: `order.create`. (Heartbeat/status events are optional.)

### 8.3 Push / pull
- `POST /api/sync/push` — body `{device_id, events[]}` (batch ≤ 50, oldest first). Response: `{acked:[client_event_id], rejected:[{client_event_id, reason}], server_time}`. The tablet marks events `sent` **only after ack**; retry with exponential backoff (5s → 5min). Server inserts into `sync_events` first, then processes; processing is idempotent via `client_event_id`.
- `GET /api/sync/config?since=<version>` — returns products (id, name, category, color, sort, active — **no prices**), shift settings, `valid_tickets` token-hash list (only `issued`), `config_version`, `server_time`. Poll every 60 s when online and on app resume.
- The tablet works fully from local config when offline.

### 8.4 Server validation on push
Reject/flag: unknown device or revoked key; hash chain mismatch (`prev_hash`) → critical alert; sequence gap (missing seq → alert, still process what arrived); duplicate `client_event_id` (ack silently); `qty`/lines out of bounds; unknown/inactive product (reject, alert); ticket invalid/used (see §7.6); effective time too old (> `max_offline_hours`, default 72h → flag `late_sync`) or in the future (> 5 min after correction → flag).

### 8.5 Clock handling
Each sync response includes `server_time`; the tablet computes `offset = server_time - local_now` and stores `(offset, measured_at)`. Each event records `clock_offset_ms` (latest known). Server computes `effective_ts = client_ts + clock_offset_ms`. If the offset jumps by more than a threshold (default 2 min) between syncs, or `|received_at - effective_ts|` is inconsistent with the offline period, flag `clock_skew` and alert. Kiosk mode must prevent changing the device clock.

### 8.6 Failure modes
| Failure | Handling |
|---|---|
| Internet down for hours/days | Orders accumulate locally; UI shows offline badge + pending count; sync on return |
| Tablet restarted/crashed mid-order | Orders are written to IndexedDB **before** the success screen; an unconfirmed cart is simply lost (not an order) |
| Tablet lost/broken before sync | Unsynced orders are lost → alert "device silent > X h"; recommend stable Wi-Fi and fast sync |
| Duplicate send | Idempotent by `client_event_id` |
| Storage cleared | Kiosk blocks app-data clearing; if seq restarts the server sees a gap/regression → critical alert |
| Same ticket used offline twice | §7.6 conflict handling |
| Stolen device key | Admin revokes the device; new pairing required |

---

## 9. Device pairing & authentication
- **Tablet:** Admin creates a one-time pairing code (expires in 10 min); the tablet enters it once and receives a random 256-bit device key (server stores only its hash). All `/api/sync/*` and `/api/pos/*` calls send `Authorization: Bearer <device_key>`. Keys are revocable. Rate-limit per device.
- **Admin:** email + strong password + TOTP 2FA; HttpOnly secure cookie sessions; login rate limiting & lockout; every action audited. Admin session is **independent** from the kiosk exit code.
- **Public endpoints:** none except login and static assets. Ticket QR URLs, if used, must not reveal data (the app reads the token locally; a GET on the URL shows nothing sensitive).

---

## 10. Worker UI (tablet) — "blind" POS

**Principles:** huge touch targets (≥ 72 px), RTL Arabic, high contrast, zero jargon, no scrolling during normal use (paginate or compact grid), no zoom, no text selection, prevent accidental navigation.

**Main screen**
- Grid of product tiles (name, color, optional icon). **Each tap = +1.** A large count badge appears on the tile. A visible **−** on the tile reduces by 1.
- Bottom bar: **[مسح الكل]** (clear cart) and **[تأكيد الطلب]** (confirm) showing only the number of items (e.g. "3 عناصر"), **never an amount**.
- Offline/online indicator (small icon) and "pending to sync" counter (number only).

**Confirm flow**
1. Tap confirm → summary list of **product names × quantities** (so the worker can verify what they entered; no prices), with a visible warning (**confirmed**): "تأكد من الطلب — لا يمكن إلغاؤه بعد التأكيد" (check the order — it cannot be cancelled after confirmation).
2. Choose **[كاش]** or **[تذكرة]**.
3. Ticket: camera scanner opens (or numeric/short-code input). Result ✓ "تذكرة صالحة" or ✗ generic "التذكرة غير صالحة".
4. Success overlay "تم ✓ الطلب رقم T1-0045" for ~1.5 s, then cart resets.
5. Double-submit protection (disable button while writing; event already idempotent).

**Explicitly hidden from workers:** prices, totals, stock, ticket owner/value/type, reports, order history details. (A minimal "last orders" list with labels and items but **no money** may be added later **[ASSUMPTION: not in v1]**.)
**No cancel button for confirmed orders.** To correct a mistake the worker tells the Owner, who voids/re-enters from admin.
**Kiosk:** runs inside Fully Kiosk Browser; cannot leave except via the kiosk admin code (§13).

**Arabic strings (initial):** confirm = "تأكيد الطلب"; clear = "مسح"; cash = "كاش"; ticket = "تذكرة"; success = "تم تسجيل الطلب"; offline = "بدون إنترنت — الطلبات محفوظة"; pending = "في الانتظار: N".

---

## 11. Admin UI (Owner)

Responsive web app (works on phone and PC). Pages:
1. **Dashboard:** today / week / month cards (cash revenue, purchases + other variable, fixed (prorated), profit, free giveaways, credit outstanding); **per-shift table for today** (assigned worker, orders, revenue, margin used, cash variance, risk color); alerts list; device status (last sync, pending). 
2. **Products:** CRUD (new products at any time), color/order, active toggle, price history (new price = new `product_prices` row with effective time), **recipe editor** (stock item, nominal qty, real qty — enterable as grams or as "units per kg", accounted and real; new version on save), computed unit cost and unit margin.
3. **Stock:** items list (theoretical qty in kg/pieces, avg cost, min threshold, low-stock highlight); actions: **Purchase** (invoice ref, paid from drawer/owner), **Count** (entered from the trusted person's paper with the actual count time; shift handover / unannounced / weekly; shows variance, margin used %, value in DT), **Waste**, **Staff consumption**; count history & trends per item/shift.
4. **Tickets:** issue a **sheet** (type, customer, number of tickets, optional cap, note) → **print QR sheet** (A4 with cut-out tickets); remaining unused tickets per customer (low-tickets highlight); list with status; void unused; per-shift reconciliation view (ticket papers vs ticket orders).
5. **Credit (كريدي):** customers, balances, ledger, record repayment.
6. **Shifts & responsibility:** default worker per shift; roster per day/shift editable at any time; cash count entry per handover.
7. **Expenses:** fixed (monthly: wages, rent…) with start/end; variable (purchases auto-created from stock purchases + other expenses).
8. **Orders:** list/filter by day/shift/status/flags, order detail, **void** (reason).
9. **Statistics:** per-product profitability (loss-making highlighted), by hour, by shift/worker, credit aging, date range selector, CSV export.
10. **Alerts & audit log:** acknowledge alerts; filterable audit trail.
11. **Devices & settings:** pair/revoke tablets, shift hours, thresholds, Telegram/email report config, 2FA, change password.

---

## 12. API summary (JSON, Zod-validated)

```
Worker/device (Bearer device key):
  POST /api/sync/push            # events → acks/rejections, server_time
  GET  /api/sync/config          # catalogue (no prices), valid ticket hashes, settings, server_time
  POST /api/device/heartbeat     # optional: last_seen, app version
Admin (session cookie + CSRF):
  POST /api/admin/auth/login | /2fa | /logout
  CRUD /api/admin/products, /products/:id/prices, /products/:id/recipe
  CRUD /api/admin/stock-items ; POST /stock/purchase | /stock/count | /stock/waste | /stock/staff
  POST /api/admin/tickets ; GET /tickets ; POST /tickets/:id/void ; GET /tickets/:id/print
  CRUD /api/admin/customers ; POST /credit/payment
  GET/PUT /api/admin/roster ; POST /cash-counts
  CRUD /api/admin/expenses
  GET /api/admin/orders ; POST /orders/:id/void ; POST /orders/manual (audited)
  GET /api/admin/reports/dashboard | /profit | /products | /hours | /shifts | /credit
  GET /api/admin/alerts ; POST /alerts/:id/ack ; GET /audit
  POST /api/admin/devices/pair-code ; POST /devices/:id/revoke ; GET/PUT /settings
```
Camera-footage timing: the system exposes order times in Tunis local time so the Owner can jump to the same minute on the CCTV recording; no video is stored in this system.

---

## 13. Hardware, kiosk & deployment

- **Tablet (budget < 500 DT):** 10–11″, ≥ 4 GB real RAM, Android 12+, Wi-Fi. Candidates seen in Tunisian shops: Bmax MaxPad I9 Plus (~259 DT; weaker CPU, small-brand SAV; its "12 GB RAM" is 4 GB + virtual), Samsung Galaxy Tab A11 (~469 DT; check screen size), Infinix XPad 30E 11″ (~469 DT). Prices change — verify. Mount on the wall with a fixed bracket and permanent charging (use a charge limit/smart plug if available to protect the battery).
- **Fully Kiosk Browser (PLUS licence) settings:** single-app kiosk on the POS URL; **admin PIN** for exit/settings; start on boot; keep screen on; hide status/navigation bars; disable pull-to-refresh, text selection and zoom; allow camera for the site; block settings/clock changes (device-owner/lock-task if provisioned); disable app-data clearing; remote admin enabled with strong password; auto-reload on connection return; screenshots disabled.
- **QR scanning:** requires HTTPS (guaranteed in cloud hosting). If the tablet camera is also used for monitoring, scanning conflicts → use a **separate CCTV camera** for surveillance (recommended). Optional fallback: USB/Bluetooth QR scanner (acts as keyboard).
- **Printing tickets:** from admin to any printer (A4 with several tickets per page) or a thermal printer; no worker-side printing.
- **Environment/secrets:** `DATABASE_URL`, `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY`, `TELEGRAM_BOT_TOKEN`, `TZ=Africa/Tunis` (logic still uses IANA zone explicitly). Backups: provider PITR + a nightly logical export to external storage. Region: EU (nearest to Tunisia).
- **Legal/ethical:** staff must be informed that orders, stock and shifts are logged and audited; any CCTV must be **overt with signage**. Check Tunisian rules on fiscal cash registers/invoicing and personal data with the accountant/legal advisor — this system is **not** certified as a fiscal register.

---

## 14. Threat model — known loopholes and mitigations

| # | Loophole | Mitigation in this design |
|---|---|---|
| 1 | Sell and pocket cash without recording | Stock counts at each handover (§7.4); pattern alerts; blind UI; CCTV time-matching; mystery shopper (process, not code) |
| 2 | Hide sales inside the coffee/jirak margin | Explicit margin accounting: `margin_used_pct` per shift; alert on sustained high usage; Owner tunes margin as evidence accumulates |
| 3 | Register a cheaper item than served | Each stock item is checked independently (e.g., missing jirak) |
| 4 | Register fewer units than served | Same as #1 over repeated shifts |
| 5 | Pocket cash after registering | Cash count at handover (§7.5) |
| 6 | Fake/duplicated/photocopied ticket; ticket reuse | Random unguessable QR, single use, admin-issued only, paper reconciliation, reuse alerts |
| 7 | Record a cash sale as "ticket" | Needs a valid unused admin-issued ticket + paper in drawer + ticket count check |
| 8 | Void after taking money | Workers cannot void; admin-only with reason; void spikes alert |
| 9 | Remove/alter local records | Append-only, per-device sequence, hash chain, gap detection (§3 rule 4, §8.4) |
| 10 | Change tablet clock to move sales between shifts | Server-corrected time, offset monitoring, kiosk blocks clock changes |
| 11 | Unplug network/power to create unrecorded windows | Device-silent and no-orders-in-busy-hours alerts; offline logging continues anyway |
| 12 | Take whole packs home | Appears as count variance (same detection as #1) |
| 13 | Dishonest counting | Counts by Owner/trusted non-shift person, unannounced counts, optional photo of shelf (backlog) |
| 14 | Inflated purchases / short deliveries | Only Owner enters purchases; count goods at delivery |
| 15 | Overcharging customers | Prices posted visibly to customers; mystery shopper (process) |
| 16 | Staff consumption hiding theft | Owner-defined staff allowance recorded as `staff_consumption` |
| 17 | Admin takeover / data tampering | Strong password + TOTP, rate limits, no hard deletes, audit log, external backups |
| 18 | Fake orders by someone with the URL | Device-key auth, revocation, per-device sequence/hash |
| 19 | Several workers per shift (can't tell who) | Known limit of the Owner's per-shift responsibility decision; mitigated by roster + CCTV |
| 20 | False accusation risk | Neutral wording, pattern-based risk score, documented staff policy |

---

## 15. Statistics & report definitions (for implementers)
- Use `business_day` and Tunis time for every grouping; **never** group by UTC date.
- A product's **unit margin** = current price − current recipe unit cost; its **realized profit** = Σ(paid qty × price) − Σ(all qty × unit cost) over the range.
- Fixed-cost proration uses the number of days of **each calendar month** the day falls in.
- Currency formatting: `amount_millimes / 1000` with exactly 3 decimals, `DT` suffix, Arabic digits optional (default Western digits).

---

## 16. Delivery plan, acceptance criteria & tests

**Phase 1 — Core (must work offline end-to-end)**
- Device pairing; worker app (blind UI, cart, payment choice, offline storage, outbox, sync, hash chain, per-device sequence).
- Server: schema, sync push/pull, shift logic, order processing (prices/costs/recipes versions), stock movements, products/prices/recipes, stock purchase/count/waste, **margin analysis**, tickets (issue, print, scan/short code, single-use, offline validation, conflicts), roster, cash counts, void, audit log, admin login with 2FA.
- Acceptance: with the network off for 24 h and the tablet restarted several times, all orders appear once, in order, after reconnection; stock and reports match hand calculations.

**Phase 2 — Money & insight:** expenses (fixed/variable, proration), profit views (cash & consumption), credit ledger & repayments, statistics, alerts engine, shift risk score, daily Telegram report, CSV exports.

**Phase 3 — Hardening:** unannounced-count workflow, reports on trends, device health alerts, optional "last orders (no money)" list, optional second device, French UI.

**Required automated tests**
1. Shift/business-day boundaries (§7.1) incl. midnight and month/year rollover.
2. Money/stock arithmetic with integers (e.g. 80 coffees deduct exactly 1,000,000 mg; rounding rules; no float drift).
3. Margin analysis formulas (§7.4) with hand-computed examples (honest, zero-variance, negative-variance cases).
4. Price/recipe versioning: edits never change past orders.
5. Sync: idempotent re-send; ordering; gap and broken-chain detection; late sync flag; clock-offset correction.
6. Tickets: single use; reuse attempt; offline double-use conflict; cap flag; credit ledger and repayment revenue timing.
7. Void: stock and ticket/credit reversal; audit entry; workers cannot call admin endpoints.
8. Auth: device-key required for sync; revoked device rejected; admin 2FA; rate limits.
9. Reports: profit formulas (§7.8) incl. fixed proration for 28/30/31-day months.
9b. v1.1 rules: count entered late uses theoretical **at the count's `ts`**; drawer vs owner expenses in `expected_cash`; credit repayment excluded from drawer; low-stock alert at `min_qty_base`; low-tickets alert at threshold; jirak 15/kg ⇒ 66667 mg (rounding); cost at `effective_ts` for late-synced orders; hash covers every envelope field.
10. E2E (Playwright): offline order → reconnect; ticket scan flow; kiosk-safe UI (no prices/totals visible anywhere in the DOM or local storage — **assert that prices are never present in the tablet bundle/IndexedDB**).

**Definition of done (any task):** code + tests passing + migrations + audit logging for admin mutations + no invariant from §3 broken + summary of [ASSUMPTION]s used.

---

## 17. Owner decisions (2026-11-20) & remaining open questions

**Confirmed by the Owner:**
1. Credit repayments: money goes **directly to the Owner**, who records them in admin; never part of a shift drawer.
2. Ticket `max_amount`: **optional**, default none.
3. Week starts **Monday**.
4. Yields are **all editable in admin**. Initial: coffee accounted 80/kg, real 90/kg; jirak accounted **15/kg**, real **16/kg**; flavored shisha measured by the Owner. Jirak has big/small sizes (separate products); flavored shisha has one size.
5. Payment methods: **cash and tickets only**.
6. 4 workers; **one tablet-responsible worker per shift** (morning/evening). Counts are done by a **trusted person on paper**; the Owner enters them with the actual count time.
7. Tickets: **sheets** of many single-use tickets per customer, **no expiry** while unused, **low-tickets alert**; no ticket left → customer pays cash.
8. Expenses can be paid **from the shift drawer or from the Owner's money**; drawer expenses must match a purchase invoice.
9. **Everything consumed is tracked** in stock via recipes; stock decreases automatically on each order; **low-stock** and negative-stock alerts.
10. Workers cannot cancel orders; confirmation screen shows a warning.
11. Unit cost uses the cost valid at `effective_ts`; hash covers the whole envelope.
12. Stack: single Next.js app + Drizzle + Neon (EU). Git/GitHub later.
13. Worker-visible "last orders (no money)" list: not in v1.

**Implementation decisions taken during the build (v1.0 code) — to confirm:**
- [ASSUMPTION] Ticket tokens are also stored **AES-GCM encrypted** (`tickets.token_enc`, key from `TOTP_ENCRYPTION_KEY`) so the Owner can reprint a sheet; validation still uses only `sha256(token)`. A database leak alone does not reveal tokens.
- [ASSUMPTION] Admin mutations use Next.js **Server Actions** (same-origin, session + 2FA required, audited) instead of the REST endpoints listed in §12; device endpoints are REST as specified. CSV exports at `/admin/export/<kind>`.
- [ASSUMPTION] An order containing a product that was **deactivated** after the tablet went offline is **accepted with flag `inactive_product`** (a real sale must not be lost); **unknown** products are rejected (raw event kept in `sync_events`) with an alert.
- [ASSUMPTION] A third stock kind **`volume`** (base unit ml) exists for milk, juice, etc.
- [ASSUMPTION] Orders flagged `chain_broken` or `sequence_gap` go to `pending_review`.
- [ASSUMPTION] Without `DATABASE_URL` the server runs on an embedded Postgres (PGlite, `./data/db`) for single-PC local use.

**Still open (not blocking Phase 1):**
- Product catalogue, real prices, recipes, staff-consumption allowance — entered by the Owner (seed data must be clearly marked as placeholders).
- Hosting: Vercel paid plan vs VPS.
- Daily report channel (Phase 2): Telegram, email, or both.

---

## 18. Glossary (Arabic ⇄ English)
| Arabic | English |
|---|---|
| كاشي | cash drawer |
| صباحية / مسائية | morning / evening shift |
| تذكرة | ticket (QR paper) |
| مجاني | free (give-away) |
| كريدي | credit (customer debt) |
| جيراك | shisha tobacco (consumed 62.5 g per shisha at 16/kg) |
| شيشة | shisha / water-pipe |
| قزوز | soft drinks |
| جرد | stock count |
| هامش | allowed margin (waste tolerance) |
| ميليم | millime (1/1000 DT) |
| مسؤول الشيفت | person responsible for the shift (assigned by Owner) |
