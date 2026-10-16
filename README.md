# Nadhi's Couture - inventory, orders & accounts app

Replaces the Excel workbook "Nadhis Couture - Accounts.xlsx" with a web app (React + Express) backed by PostgreSQL.
Start on Supabase (Pro plan), move to AWS RDS later. **Use Supabase only as plain PostgreSQL**: no Supabase-specific
features in app logic, so the database can be moved with a dump/restore and a changed connection string.
Keep login behind one small backend module so it can switch to Amazon Cognito later.

## Status
- [x] Phase 0 decisions (below)
- [x] Phase 1 (v0.3): `db/schema.sql` + `migration/migrate.py` (dry run, load and business rules tested on PostgreSQL 16)
- [ ] Phase 2: load into Supabase and harden (guided setup in progress; all owner decisions confirmed)
- [ ] Phase 3: app screens  - [ ] Phase 4: reports/dashboard  - [ ] Phase 5: tests, backups, cutover

## Layout
    db/schema.sql                 tables, constraints, triggers, ship_order(), derived views (incl. shipments & courier settlements)
    migration/migrate.py          Excel -> PostgreSQL (dry run by default)
    migration/reports/            latest reconciliation report + cleaned CSVs for review

## Running (Windows PowerShell; on Mac/Linux use `export NAME=value` instead of `$env:NAME = "value"`)
    pip install -r migration/requirements.txt
    $env:ADMIN_DB_URL = "<Session pooler string from Supabase > Connect, with the admin password filled in>"
    # 1. dry run - reads the workbook, validates, writes report + CSVs, touches no database
    python migration/migrate.py --xlsx "Nadhis_Couture_Database_Migration_Review.xlsx"
    # 2. create schema on an EMPTY database (all-or-nothing), then load (single transaction, rolls back on any failed check)
    psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/schema.sql
    python migration/migrate.py --xlsx "Nadhis_Couture_Database_Migration_Review.xlsx" --load --dsn $env:ADMIN_DB_URL
    # 3. lock it down (limited app role, API roles blocked, Row Level Security). Safe to re-run.
    $env:APP_DB_PASSWORD = "<new strong password for the app role>"
    psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -v app_password="$env:APP_DB_PASSWORD" -f db/supabase_hardening.sql
Secrets live in environment variables or a git-ignored `.env`, never in code. `migration/reports/` holds customer
names and is git-ignored. Turn the Supabase **Data API off** (the app never uses it). The running app connects as
`app_backend` (never `postgres`); re-run the hardening script after adding any table, view or function.

## Approved decisions
| Topic | Decision |
|---|---|
| Duplicate SKUs | Lavendar variants -> `UMRC-M/L/XL-LV`; colour spelled "Lavender". Pink keep `-PK`. |
| UMV SKUs | `UMV-M-YLW`, `UMV-L-YLW` (colour Pink) -> `UMV-M-PK`, `UMV-L-PK`. |
| SO_0000004 | Quantity 1, unit cost 290 (wholesale), selling price 500. |
| PO_0000002 | Fully paid 2,660. Added a 1,330 payment `TRAN_MIG_0001` (date/method unknown, flagged). |
| Meaning of fields | Unit cost = wholesale purchase cost. Est selling price = retail list price. **Profit = selling price - unit cost.** |
| Cost on orders | ALWAYS taken from the product master Unit cost, never from the order sheet's own UnitCost (which was wrong on all 4 orders). |
| Shipping | Shipping is charged to the customer **per shipment** (`shipment.shipping_charged`), billed on one order of the parcel (`billed_order_id`, default the earliest order, or chosen) and paid with that order's payments. So an order's amount due grows as its parcels ship; money received before dispatch shows as `Advance`. The courier's charge is `shipment.courier_cost`. We pay the courier one lump sum at month end: `courier_settlement`; a shipment is "paid to courier" once linked to one. Shipping is pass-through, NOT part of profit (`shipment_summary` / `shipping_monthly` show charged vs courier cost). |
| Ship dates | All 4 existing shipments happened on 16 Oct 2026. |
| PO_0000002 | Balance 1,330 paid on 16 Oct 2026 via GPay (`TRAN_MIG_0001`). |
| PO_0000005 payment | `TRAN_00000009` corrected 580 -> 1,130 (GPay); PO_0000005 is fully paid. |
| Courier / parcels | ST Courier is the courier for all shipments; **nothing has been paid to ST Courier yet** (250 owed across the 3 existing parcels). A shipment is one PARCEL made of shipment LINES (`shipment_item`: order line + quantity). An order can ship in several parcels, and a parcel can carry lines from several orders of the SAME customer. Existing data: SO_0000003 + SO_0000004 went as one parcel (SH_0000003, billed on SO_0000003, courier cost 90). |
| Order statuses | Pending, Partially Shipped, Shipped, Delivered. Pending/Partially Shipped/Shipped follow what has shipped; Delivered once fully shipped AND every parcel delivered. |
| PO_0000005 | Total corrected 580 -> **1,130**: it covered both UMRC-2XL-BL (550) and FDM-L-BLK (580). The sheet omitted the 550. |
| Purchase lines | PO_0000005 items stated by owner (2). The other 53 variants are linked to PO_0000001 BY ELIMINATION (only two stock POs exist and the 53 at master cost total exactly 20,550). Stock enters as 'Purchase Receipt' movements linked to the PO line, dated the PO date. The migration fails the load if these totals ever stop tying. |
| Non-stock purchases | Only "Wholesale Garments" affects inventory; labels, stickers, courier covers, sewing machine do not. |
| No cancel / returns / refunds | **Out of scope by decision**: orders cannot be cancelled or returned, customers are not refunded. Enforced in the schema: no Cancelled/Returned statuses, no Return stock movements, order payments can only come In and purchase payments only go Out. Corrections to a wrong order are made by editing it BEFORE it ships. |
| Split shipments | If only part of an order is in stock, ship the available lines now and the rest after buying stock. Stock leaves per SHIPPED LINE (not at order time). Each function takes the shipping charge for that parcel. `ship_available()` ships whatever is in stock; `ship_items()` ships chosen lines/quantities; `ship_order()`/`ship_orders()` ship everything remaining. All are atomic (any failure rolls back everything). Views `order_fulfilment` and `purchase_needed` show what is waiting and what to buy. |
| Database | PostgreSQL. Hosting: Supabase Pro now, AWS RDS later. 2-3 users. |

## Design rules to keep
- Stock on hand and paid/balance are derived (views), never stored or hand-edited.
- `inventory_movement` is append-only; fix mistakes with a reversing movement.
- Payments belong to exactly one of: purchase order or sales order. Courier month-end payments are `courier_settlement` rows (cash out) - include them in cash reports. Order and purchase payments have a fixed direction (customers pay In, we pay Out).
- Never set order status Pending/Partially Shipped/Shipped/Delivered by hand: use the ship_* functions and shipment status updates. After editing order lines, call `refresh_order_shipping_status(order_id)`.
- Never ship more than ordered (enforced by trigger); one parcel = one customer; stock can never go negative.
- Keep business codes (SKU, PO_, SO_, TRAN_, SPLR, CUST) as unique text; never renumber.
- Amounts are INR numeric(12,2); phone numbers are text; timestamps shown in Asia/Kolkata.
- The backend must run each business action (create order, ship, record payment) in one DB transaction.

## Open items (none block the load)
1. Proposed shipment statuses: Shipped, In Transit, Delivered.
2. Phase 3: backend must generate the next SO_/PO_/TRAN_/CS_ codes. Shipment codes (SH_) come from a sequence and may skip numbers after a rolled-back shipment attempt.
3. Phase 3: when a parcel ships, the app should ask for that parcel's shipping charge and courier cost (defaults 0), and, for a combined parcel, which order carries the charge.
4. Phase 3: since orders cannot be cancelled, decide how to handle an order entered by mistake before anything has shipped or been paid (e.g. allow deleting such an order).

(Resolved: the 550 stock-vs-purchase gap; PO_0000005 payment; payment methods; courier identity and unpaid status; SO_0000003/4 parcel; split shipments; per-shipment shipping charge; no cancel/returns/refunds.)
