# Nadhi's Couture admin app - project details (for planning the public storefront)

Purpose of this file: give a planner (Claude app or a person) everything needed to design a **public online storefront**
that reads from, and writes to, the **same PostgreSQL database** as the existing private admin app. It describes what is
built, the database, the business rules the storefront must respect, and the gaps the storefront will need to fill.
No secrets are in this file. Source of truth for any detail: `db/schema.sql`, `db/migrations/`, `README.md`, `server/src/routes/`.

---

## 1. The business and the admin app in one paragraph

Nadhi's Couture is a small women's clothing boutique (2-3 staff users). The admin app replaced an Excel workbook. It
manages products and variants (fabric / size / colour), stock, suppliers, customers, purchase orders, customer orders,
split shipments (parcels), courier month-end settlements, payments, and reports. All amounts are INR. Orders are
currently entered by staff (e.g. after WhatsApp / phone / Instagram conversations); **there is no online storefront yet**
(it was explicitly "out of scope" for the admin app: online storefront, online payments, multiple currencies).

## 2. Architecture today

| Layer | Detail |
|---|---|
| Database | PostgreSQL (Supabase Pro now; AWS RDS planned later). Supabase is used as **plain PostgreSQL only** - no Supabase Auth, Storage, Realtime, or Data API. The Supabase Data API is switched **off**. |
| Backend | Node 20+ / Express 4, `pg` driver with plain parameterised SQL (no ORM), `zod` validation, `decimal.js` for money, `helmet`, `express-session` + `connect-pg-simple`, `bcryptjs`, `express-rate-limit`. ES modules. |
| Frontend | React 18 + Vite + react-router, mobile-friendly, brand colours as CSS variables (`client/src/styles.css`). Logo in `client/public/`. |
| Hosting | Docker (app container + Caddy for automatic HTTPS) on one AWS EC2 instance (Mumbai, ap-south-1), database stays on Supabase. See `docs/DEPLOY_AWS.md`. |
| Repo layout | npm workspaces: `server/`, `client/`; `db/` (schema, migrations, hardening); `migration/` (Excel -> Postgres loader); `docs/`. |
| Tests | Vitest + supertest against the **DEV** database, each test in a rolled-back transaction. |
| Config | Environment variables only (`APP_DB_URL`, `DB_CA_CERT_FILE`, `SESSION_SECRET`, `PORT`, `NODE_ENV`). |

Environments: **two separate Supabase projects - DEV (copy of data, may be reset) and PRODUCTION (real data, loaded and
verified against the workbook)**. Status: production schema + data ready, app deployed on EC2 with a production login;
remaining are phone smoke test, PITR decision and cutover.

The admin app talks to the DB through the limited role **`app_backend`** (never `postgres`). The browser never talks to
the database; all access goes through the Express API.

## 3. What the admin app does (screens and API)

All API routes are under `/api`, all behind login except `/api/health` and `/api/auth/*`. Roles: `owner`, `staff`.

| Area | Screen(s) | API | Notes |
|---|---|---|---|
| Login | Login | `POST /auth/login`, `/auth/logout`, `GET /auth/me` | Email + password, 12h rolling session cookie, rate limited. Isolated in `server/src/auth/` so it can move to Cognito. |
| Products & variants | Products, Variant form | `/products`, `/variants` (list, get, create, patch, `suggest-sku`), `/lookups` (+ add fabric/colour/size) | A **product** has many **variants** (fabric x size x colour). Hide/show (`is_active`), never delete. Live margin = list price - unit cost. Auto-suggested SKU. |
| Inventory | Inventory | `/inventory`, `/inventory/:id/movements`, `POST /inventory/adjustments` | On-hand per variant; adjustments need a reason + user; ledger is append-only. |
| Suppliers / Customers | Parties | `/suppliers`, `/customers` | Suppliers include couriers. Phone stored as text, unique when present. |
| Purchases | Purchases | `/purchases` (+ `/receive`, `/payments`) | PO header + lines; receiving adds stock; payments to supplier; non-stock purchases (labels, covers, equipment) have no lines. |
| Orders | Orders, Order form/detail | `/orders` (list, get, create, patch, `/payments`, `/refunds`, `/lookups`) | Multi-line orders; unit price defaults to list price, editable with a per-line discount; editable only while Pending / Partially Shipped. |
| Shipping | Shipping, Shipment detail | `/shipments` (`/ready`, `/to-buy`, `/candidates`, create, `/:id/status`, patch) | Ships through DB functions; partial and combined parcels; mark In Transit / Delivered. |
| Courier month-end | Courier month end | `/courier` (`/payable`, `/parcels`, `/settlements`) | Pay the courier one lump sum per month, reconciled against parcels. |
| Reports / Home | Home, Reports | `/reports` (`overview`, `monthly`, `products`, `product-months`, `stock`, `payables`) | Read-only dashboards: sales/profit by month and product, money in vs out, stock value, payables, shipping charged vs courier cost. |

## 4. Database schema (PostgreSQL, `public` schema)

Conventions: money is `numeric(12,2)` INR (currency not stored); primary keys are UUIDs; **business codes are unique text and
never renumbered**; dates are `date`, event times `timestamptz` (displayed in Asia/Kolkata); phone is text.

### 4.1 Reference (controlled value) tables
`size_ref(code, sort_order)`, `colour_ref(name)`, `fabric_ref(name)`, `purchase_type_ref(name, affects_stock)`,
`payment_method_ref(name)`. Variants reference these by value (`ON UPDATE CASCADE`).

### 4.2 Core tables
| Table | Key columns / rules |
|---|---|
| `product` | `product_id`, `name` (unique, trimmed), `product_code` (unique, nullable), `is_active`. **No description, category, images, or slug.** |
| `product_variant` | `variant_id`, `product_id`, `sku` (unique), `fabric`, `size`, `colour`, `unit_cost` (wholesale cost - **private, never expose**), `list_price` (retail price), `default_supplier_id`, `is_active`. Unique on (product, fabric, size, colour). |
| `customer` | `customer_id`, `customer_code` (`CUST000001` style), `name`, `phone` (unique if present), `email`, `location`, `is_active`. **No address columns, no password/login.** |
| `customer_order` | `order_id`, `order_code` (`SO_0000001`), `customer_id` (**nullable = guest sale**), `order_date`, `status` in (Pending, Partially Shipped, Shipped, Delivered), `notes`. |
| `order_item` | `order_item_id`, `order_id`, `line_no`, `variant_id`, `quantity`, `unit_price` (snapshot at sale), `discount` (per line, total not per unit), `unit_cost_snapshot` (private). |
| `payment_transaction` | `transaction_code` (`TRAN_00000001`), `txn_date`, `direction` In/Out, `amount > 0`, `payment_method`, `payment_status` (Completed/Pending/Failed), belongs to exactly one of `order_id` / `purchase_order_id`, `note`. Customer pays **In**; **Out** on an order is only a refund of overpayment and needs a reason. |
| `shipment` | `shipment_code` (`SH_0000001`, gapless via trigger), `courier_supplier_id`, `tracking_number`, `shipment_status` (Shipped / In Transit / Delivered), `shipped_on`, `delivered_on`, `courier_cost` (private), `shipping_charged` (charged to the customer, per parcel), `billed_order_id`, `courier_settlement_id`. |
| `shipment_item` | A parcel line = order line + quantity. One order can ship in several parcels; one parcel can carry lines from several orders **of the same customer**. |
| `inventory_movement` | **Append-only ledger.** Types: Opening Balance, Purchase Receipt, Sale Shipped, Adjustment. Signed `quantity`. |
| `supplier`, `purchase_order`, `purchase_order_item`, `courier_settlement`, `expense` | Back-office; not relevant to a storefront. |
| `app_user`, `app_session` | Admin login (migration 001). Not for customers. |

### 4.3 Derived views (stock and money are never stored)
- `inventory_balance` - per variant `on_hand` (sum of the ledger) with sku, product, fabric/size/colour, **unit_cost**, list_price.
- `order_summary` - per order: item totals, `shipping_charged`, `order_total`, `received` (net of refunds), `balance`, `payment_state` (Unpaid / Partial / Paid / Advance / Overpaid), `product_cost`, `profit`, `paid_in`, `refunded`, shipped qty, shipment codes.
- (PLANNED, not built) `available_to_sell` - per variant: on_hand minus units still to ship on open orders; see section 7A.
- `order_fulfilment` - per order line: ordered, shipped, remaining, on_hand, can_ship_now, short_on_this_line.
- `purchase_needed` - what to buy to cover waiting orders.
- `shipment_summary`, `shipment_line_detail`, `courier_payable`, `courier_settlement_summary`, `shipping_monthly`, `purchase_order_summary`.

### 4.4 Database functions and triggers that enforce the rules
- `ship_items / ship_orders / ship_order / ship_available` - atomic shipping (creates parcel, deducts stock per shipped line, updates order status). Rolls back everything on any failure.
- `refresh_order_shipping_status(order_id)`; `sync_order_delivered` trigger (order becomes Delivered when fully shipped and all parcels delivered).
- `prevent_negative_stock` (advisory lock per variant), `block_movement_change` (append-only), `check_shipment_item` (no over-shipping, one customer per parcel), `check_order_item_qty`, `set_shipment_code`, `set_updated_at`.
- Constraints: positive money, `discount <= quantity * unit_price`, phone format `^[0-9+ ()-]{6,20}$`, trimmed non-empty codes.

### 4.5 Migrations applied (all in `db/migrations/`)
001 app users + sessions; 002 supplier/customer code counters (no longer used); 003 PO/payment counters (no longer used) + received <= ordered;
004 customer refunds of overpayments; 005 gapless shipment codes. Schema changes must be **new numbered files** applied to dev first, then
`db/supabase_hardening.sql` re-run.

### 4.6 Database security model (important for adding a second app)
`db/supabase_hardening.sql` (safe to re-run):
- Creates the single limited login role **`app_backend`**: `SELECT, INSERT, UPDATE` on all tables, `EXECUTE` on all functions, **no DELETE** (exceptions: `order_item` for editing unshipped lines, `app_session`), no TRUNCATE, no DDL, no UPDATE on `inventory_movement`, 30s statement timeout.
- Revokes everything from Supabase's `anon`, `authenticated`, `service_role` and from `PUBLIC` on functions.
- Enables **Row Level Security on every table** with a single policy `app_backend_all` for `app_backend` only; views are `security_invoker`.
- Consequence: **a new role for the storefront gets zero access until it is explicitly granted privileges AND an RLS policy.** The hardening script grants broadly to `app_backend` and would need extending (or a separate script) for a storefront role.

## 5. Business rules the storefront must respect

1. **Money**: INR, `numeric(12,2)`; never floats - use a decimal library or integer paise. The existing API returns money as strings like `"450.00"`.
2. **Stock is derived** from `inventory_movement`; never write `on_hand`. **Stock only leaves when goods ship** (Sale Shipped), not when an order is placed. There is **no reservation** in the admin app - two customers can order the last unit; the second order then sits Pending / "waiting for stock" until restocked (`order_fulfilment`, `purchase_needed`). For the storefront this is handled with a derived "available to sell" number and no locks (section 7A).
3. **Never expose** `unit_cost`, `unit_cost_snapshot`, profit, supplier data, courier cost, other customers' data, or internal notes.
4. **Order creation rules** (as implemented in `server/src/routes/orders.js`): unit price defaults to the variant's `list_price`; `unit_cost_snapshot` is taken from the variant's `unit_cost` **on the server**; variants must be `is_active`; no duplicate variant lines in one order; `discount <= quantity*unit_price`; order total capped at 9,999,999.99; next `order_code` = highest `SO_#######` + 1 computed inside the transaction under an advisory lock (`server/src/codes.js`). A storefront should reuse these rules (ideally the same code/logic), not re-invent them.
5. **Shipping**: charged **per parcel** (`shipment.shipping_charged`), billed on one order of the parcel; an order's amount due grows as its parcels ship; money paid before dispatch shows as `Advance`. Shipping is pass-through, not part of profit. Shipping charge is decided by staff at dispatch - **there is no shipping-rate table or pincode logic**.
6. **No cancellations or returns** (by decision, enforced in schema: no Cancelled/Returned statuses, no Return movements). A wrong order is fixed by editing it before it ships. The only refund is repaying a customer's **overpayment** (Out payment with reason, capped at surplus).
7. **Order statuses** follow shipping and cannot be set by hand: Pending -> Partially Shipped -> Shipped -> Delivered.
8. **Business codes** (SKU, SO_, PO_, TRAN_, SH_, CS_, CUST, SPLR) are unique text, never renumbered. New codes = highest + 1 computed in-transaction; no database counters.
9. **Customers**: today phone is unique when present and optional; `customer_id` on an order may be NULL (guest sale). Deactivate, never delete. DECIDED change for new customers: phone and address become mandatory, phone stays unique (section 7B).
10. **Transactions**: each business action (create order, ship, record payment) must run in **one DB transaction**; use parameterised SQL only.
11. **Plain-English error messages**, never raw DB errors (see `server/src/errors.js`, `UserError`).
12. **Secrets** only in environment variables / git-ignored `.env`. Only ever connect dev for development; production credentials are never in the repo.

## 6. What exists vs. what the storefront needs (gap analysis)

### Already usable
- Product / variant catalogue with fabric, size, colour, SKU, list price, active flag.
- Live stock per variant (`inventory_balance.on_hand`) - can drive "In stock / Only N left / Sold out" and size availability.
- Order + order-line + customer + payment tables that a web checkout can write to.
- Shipment tracking data (`tracking_number`, `shipment_status`, courier name) for an "order tracking" page.
- Existing data in production: a small catalogue and ~tens of stock units (verification doc quotes stock 51, 4 orders), so the storefront starts nearly empty and needs content.

### Missing in the data model (needs new numbered migrations 006+)
| Gap | Why it matters |
|---|---|
| Product **description, category/collection, slug, tags, care/fabric notes, SEO fields** | Product has only a name. |
| **Product images** (no storage, no URLs) | Needs an image table (`product_image`: product/variant, url, alt, sort) and a place to host files (S3 / Supabase Storage / CDN). |
| **Publish-to-web flag** (e.g. `is_published` / `show_on_storefront`) separate from `is_active` | Admin may keep a variant active for internal orders but not list it publicly. |
| **Customer address** (only free-text `location` today) | DECIDED: add a mandatory address for every NEW customer, and make phone mandatory too. See section 7B. |
| **Customer accounts / auth** (none; `app_user` is staff only) | Decide: guest checkout only, phone/email OTP, or accounts (e.g. Cognito). Do **not** reuse `app_user`. |
| **Order source / channel** (web vs. staff-entered), web order reference, payment-gateway ids | Distinguish storefront orders; track gateway order id/payment id. |
| **Online payment** (explicitly out of scope so far; `payment_transaction` has methods list and Pending/Failed statuses but no gateway fields) | Need a gateway (e.g. Razorpay / UPI), webhooks, and mapping to `payment_transaction` (In, with `payment_status`). Decide prepaid-only vs. COD. |
| **Shipping charge rules** at checkout (flat / by region / free above amount) | Today staff types the charge at dispatch. |
| **"Available to sell"** number (stock minus units already promised to open orders) | Currently none. DECIDED: add a derived view and use it for the catalogue and the checkout check; no locks or holds. See section 7A. |
| **Storefront DB role + RLS policies** | See 4.6; the storefront should NOT use `app_backend`. |
| Notifications (order confirmation email / WhatsApp), GST invoices, coupons, wishlists, reviews | None exist. |

## 7. Key design decisions the planner should settle

1. **How the storefront reaches the data**
   - (a) Storefront gets its **own backend/API** and its **own limited DB role** (recommended), or
   - (b) Storefront calls the existing admin API (not recommended: admin auth, wrong trust boundary), or
   - (c) Storefront talks straight to Supabase's Data API / client SDK (**not recommended and currently disabled by design**; would require re-enabling a deliberately locked-down surface).
2. **Least-privilege role**: e.g. `storefront_reader` / `storefront_backend` with SELECT only on purpose-built **public views** (published products, price, availability - never `unit_cost`), and INSERT only through a **database function** such as `place_web_order(...)` that creates customer + order + lines atomically. No access to `payment_transaction`, supplier, profit or cost columns directly. RLS policies must be added for the new role.
3. **Order placement semantics**: reuse the same rules as 5.4 (price from `list_price` on the server, cost snapshot from master, code generation under lock - that existing code-number lock stays, it is not a stock lock). Web orders start `Pending` and appear to staff in the admin app. Stock availability is checked as described in section 7A.
4. **Payments flow**: prepaid via gateway vs. COD vs. "pay on WhatsApp confirmation"; how a gateway payment becomes an `In` `payment_transaction` (and how `Advance` state, overpayment refunds, and "no cancellations" interact with failed/abandoned online payments).
5. **Stock display and oversell policy**: DECIDED, see section 7A.
6. **Guest vs. account checkout**, and de-duplication against existing customers by unique phone number.
7. **Image/content storage and admin workflow**: who uploads images and descriptions - probably new fields/screens in the **admin app** (an admin task that precedes storefront launch).
8. **Hosting and domain**: same EC2 + Caddy, separate container, or a static/SSR host (e.g. Vercel / Next.js). Database connection limits: the admin pool uses max 5 connections through the Supabase pooler; the storefront needs its own small pool (or a read replica / cache) so traffic spikes cannot starve the admin app.
9. **Caching / performance**: the catalogue changes rarely; cache public product lists, but keep stock live (short TTL).
10. **Compliance**: privacy policy, terms, Indian e-commerce/GST details, handling of customer phone numbers and addresses (personal data).
11. **No cancellation/return policy** must be stated clearly on the storefront (matches the business decision).

## 7A. DECIDED: "available to sell" and stock display (no locks, no holds)

**Problem.** Stock only leaves the ledger when goods SHIP (a core rule, do not change it). So between "order placed" and
"shipped", `inventory_balance.on_hand` still shows the units that are already promised to someone. Two shoppers could
therefore both order the last unit.

**Decision (owner).** Do not lock, hold or reserve stock, and do not decrease stock at order time. Instead:

1. **Derive an "available to sell" number** (new view in a numbered migration, e.g. `available_to_sell`, then re-run the
   hardening script). Per variant:
   `available = on_hand - units still to ship on open orders` (orders with status Pending or Partially Shipped; the
   per-line "remaining" is already computed in `order_fulfilment`), never below 0. It is derived, nothing is stored. It counts
   orders entered by staff in the admin app as well as web orders, so both channels see the same number.
2. **Catalogue display** (product list and product page, per variant/size):
   - `available = 0` -> show **"Sold out"** and disable "Add to cart".
   - `available` from 1 up to the low-stock threshold (**DECIDED: 3**) -> show **"Only N left"** (N = the available number).
   - above 3 -> **"In stock"** (no number shown). The threshold is a single setting so the owner can change it later.
   Only these labels and N go to the browser; never expose `on_hand`, `unit_cost`, or other orders.
3. **Checkout check.** Inside the order-placement transaction (a database function such as `place_web_order()`), re-read
   `available_to_sell` for every line and refuse with a plain-English message such as "Sorry, only 1 left" or "Sorry, this
   item has just sold out". Quantity in the cart is capped at `available`.
4. **No locks, no holds.** No stock lock, no advisory lock on variants, no cart-hold table with expiry. Because nothing is
   locked, two shoppers placing an order in the same instant can both pass the check and slightly oversell. This is
   accepted on purpose: the system already handles it as a normal "waiting for stock" order (`order_fulfilment`,
   `purchase_needed`, `waiting_for_stock` in the admin app), staff buy more or contact the customer, and the stock ledger
   itself can never go negative (the database refuses to ship what is not there). At this shop's volume it is rare.
5. **Order is created only when it is real.** Because there are no holds and orders cannot be cancelled, do NOT create an
   order for an abandoned cart or an unpaid online payment attempt. For online payment: create the order (and its `In`
   payment row) only after the gateway confirms payment. If the item sold out between "Pay" and confirmation, still accept it
   as a waiting order and let staff handle it (refunds exist only for overpayments, so do not auto-refund).
6. **Unchanged:** the admin app still allows backorders (it does not check availability), shipping still checks `on_hand`
   (the ledger rule), and the ledger remains append-only.

Open item for the owner: whether a sold-out item can offer "notify me when back in stock" later.

## 7B. DECIDED AND BUILT (migration 006, applied to DEV): customer phone and address are mandatory; phone is unique

**Built in the admin app:** one saved address per customer on the `customer` row (`address_line1`, `address_line2`, `city`,
`state`, `pincode`); phone + address required for new customers by the API and by a database trigger (app role only); phone
unique by its last 10 digits (`customer_phone_digits_uq`); old customers are asked for the details when next edited.
Production still needs migration 006 (take a backup first). The details below are the original design notes; where they
differ (for example the trigger instead of NOT VALID constraints), the built behaviour above wins. NOTE: the trigger only
checks the `app_backend` role, so when a storefront role is added, extend `require_customer_contact()` to cover it (or
create customers only through a function) so the same rules hold there.

**Decision (owner).** Whenever a NEW customer is added - from the storefront checkout or from the admin app - both the
**phone number and the delivery address are required**. The phone number is the customer's unique identity: the same phone
can never be saved twice.

**Today (as built).** `customer.phone` is optional but unique when present (partial unique index `customer_phone_uq`, format
`^[0-9+ ()-]{6,20}$`); there are no address columns, only free-text `location`. Some existing customers may have no phone, so the
new rules must not break existing rows.

**What to build (new numbered migration, then re-run the hardening script; apply to dev first):**
1. **Address fields on `customer`** (or a separate `customer_address` table if several addresses per customer are wanted
   later; one address is enough to start): `address_line1` (required), `address_line2`, `city` (required), `state` (required),
   `pincode` (required, 6 digits, text), and keep `location` for existing data.
2. **Mandatory for new rows only**: add the NOT NULL / CHECK rules as `NOT VALID` constraints (enforced for every new insert
   and update, but existing rows are not rejected), and backfill old customers gradually from the admin app. Do not delete or
   renumber existing customers.
3. **Phone required and unique**: for new rows require a non-empty phone; keep the unique index. Compare phones in one
   normalised form (digits only, ignoring spaces, dashes and a leading +91 / 0), so "98765 43210" and "+91 9876543210"
   count as the SAME number. Store the normalised value (or add a normalised column with the unique index on it).
4. **Duplicate behaviour**: if the phone already exists, never create a second customer and never show a raw database error.
   - Admin app: plain message "A customer with this phone number already exists (CUST000123 - Name)" with a link to that customer.
   - Storefront checkout: reuse the existing customer for that phone (do not reveal other details to the shopper; do not
     overwrite the saved address silently - store the delivery address on the order, or ask staff to confirm a change).
5. **Both apps enforce it**: the database rule is the safety net; the admin API (`server/src/routes/parties.js`, customers form
   `client/src/pages/PartyFormPage.jsx`) and the storefront must validate with plain-English messages, e.g. "Please enter the
   phone number", "Please enter the delivery address", "That does not look like a valid PIN code".
6. **Which address is shipped to?** Decide whether the order should keep its own snapshot of the delivery address (recommended
   for a changing address or a gift), since a parcel is one customer but addresses change over time. Suggest columns on
   `customer_order` (name, phone, address copy) filled at order time.
7. **Privacy**: phone and address are personal data; the storefront role may only touch its own checkout customer rows via a
   database function, never list customers.

## 8. Operational constraints to plan around

- 2-3 admin users; very low data volume (hundreds of rows) - simplicity beats scale.
- Migration discipline: new numbered file in `db/migrations/`, apply to **dev first**, re-run `db/supabase_hardening.sql`, never rewrite `db/schema.sql`, ask before destructive commands.
- Backups: `scripts/backup.ps1` (pg_dump to a local folder), Supabase daily backups; Point-in-Time Recovery is still an open decision - take a backup before any storefront migration on production.
- Tests run against dev only; the storefront should have its own tests, also dev-only.
- The repo is public on GitHub: never commit `.env`, certs other than the public Supabase CA, customer data, or the source workbook.
- Owner is new to web development: prefer plain-language explanations, small steps, one feature at a time; mobile-first screens (customers will mostly browse on phones).

## 9. Suggested phased plan (starting point for the planner to refine)

1. **Content & data model** (admin app + migration 006): publish flag, descriptions, categories, images (+ storage), mandatory customer phone + address with unique phone (section 7B), order source.
2. **Read-only storefront**: catalogue, product page with size/colour selector and "Only N left" / "Sold out" status (from `available_to_sell`, section 7A), from public views through a dedicated read-only DB role.
3. **Checkout without online payment**: cart, guest details, `place_web_order()` function, order appears in the admin app as Pending; confirmation message.
4. **Online payments** via a gateway + webhook that records `payment_transaction` rows.
5. **Order tracking** page (order code + phone), using shipment status/tracking number.
6. **Polish**: SEO, analytics, notifications, performance, security review (rate limiting, bot protection on checkout).

## 10. Key files to read for more detail

- `README.md` - decisions and design rules (read first).
- `CLAUDE.md` - hard rules for working in this repo.
- `db/schema.sql`, `db/migrations/00*.sql`, `db/supabase_hardening.sql` - the data model and security model.
- `server/src/routes/orders.js`, `variants.js`, `shipments.js`, `reports.js` - existing business logic worth reusing or mirroring.
- `server/src/codes.js`, `money.js`, `errors.js`, `validation.js`, `db.js` - shared helpers (code generation, decimal money, plain-English errors, transactions).
- `docs/DEPLOY_AWS.md`, `docs/BACKUP_RESTORE.md` - deployment and recovery.
