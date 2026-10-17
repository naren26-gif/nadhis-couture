# Phase 3 brief - the application

## Goal
Replace the Excel workbook with a web app that 2-3 people use daily. The first thing the owner asked for: **enter a
product through interactive input controls (dropdowns, number fields, buttons) and store it in the database.**

## Stack (proposed - Claude Code may suggest changes with reasons)
- Frontend: React (Vite), responsive. Backend: Node.js + Express with the `pg` driver (plain SQL, no ORM unless justified).
- Database: PostgreSQL, accessed only through the backend using `APP_DB_URL`. The browser never talks to the database.
- Auth: email + password for 2-3 users, roles `owner` and `staff`; secure session cookies; hashed passwords; login rate limiting.
  Needs a small `app_user` table (add it with a migration). Keep it behind one module.
- Later: containerise (Docker) and deploy on AWS. Keep configuration in environment variables.

## Build order (finish and test each before the next)
1. **Project skeleton + login + health check**; connect to the dev database; one test that reads from `inventory_balance`.
2. **Products & variants** - the first real screen:
   - Form: product (pick existing or add new), fabric, size, colour (dropdowns from `fabric_ref`, `size_ref`, `colour_ref`,
     with a way to add a new value), unit cost, list price (numbers, validated >= 0), optional default supplier, SKU
     (suggested automatically, editable, must be unique).
   - List with search and filters (product, size, colour, in/out of stock), edit, and deactivate (never delete).
   - Show live margin = list price - unit cost.
3. **Inventory** - on-hand per variant (`inventory_balance`); stock adjustments with a mandatory reason (append-only movements).
4. **Suppliers and customers** - list, add, edit (phone numbers are text).
5. **Purchases** - PO header + lines (variant, quantity, unit cost from the product master), receive stock
   (Purchase Receipt movements), record payments to the supplier (GPay etc.). Non-stock purchase types (labels, stickers,
   packaging, equipment) have no lines and add no stock. Show paid / balance from `purchase_order_summary`.
6. **Orders** - multi-line orders for a customer; unit price defaults to the list price (editable, with discount); unit cost
   snapshot comes from the variant's unit cost; record customer payments (money received before shipping shows as Advance).
7. **Shipping** - from an order: "Ship available now" (partial), choose lines and quantities, or ship everything left;
   one parcel can carry lines from several orders of the same customer. Ask for the courier cost, the shipping charge for
   THIS parcel (and, for a combined parcel, which order carries it), tracking number. Mark parcels Delivered.
   Show `order_fulfilment` and `purchase_needed` (what to buy to complete waiting orders).
8. **Courier month-end** - list unpaid parcels by month (`courier_payable`), record one settlement for the month, check
   it matches (`courier_settlement_summary`).
9. **Dashboard/reports** (rebuild the old Dashboard sheet): stock value and on-hand, sales and profit by month and product,
   money in vs out, supplier payables, courier payable, shipping charged vs courier cost (`shipping_monthly`).

## The app must also
- Generate the next business codes safely (SO_, PO_, TRAN_, CS_, CUST, SPLR); use sequences added by a migration.
- Show who did what: record the logged-in user on adjustments and key actions.
- Have automated tests that run against the DEV database (never production), including the shipping and stock rules.

## Out of scope (by decision)
Cancellations, returns, multiple currencies, online payments, online storefront. (Refunds are out of scope EXCEPT repaying a
customer's overpayment, added later by decision: see README.)

## Data note
Production and dev are separate Supabase projects. Dev holds a copy of the migrated data for realistic testing and may be
reset at any time. The production project is not touched until cutover.
