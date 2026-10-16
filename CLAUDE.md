# Nadhi's Couture - instructions for Claude Code

Read `README.md` (decisions, design rules) and `docs/PHASE3_BRIEF.md` (what to build) before doing anything.

## What this is
A small web app for a women's clothing boutique (2-3 users): products and variants, stock, suppliers, customers,
purchases, orders, split shipments, courier settlements, payments, and reports. Data lives in PostgreSQL (Supabase now,
AWS RDS later). The database schema and business rules are DONE and tested (`db/schema.sql`); the app sits on top of them.

## Hard rules (safety first - this is a real business's accounting data)
- NEVER print, log, commit, or ask me to paste passwords or connection strings. Secrets live only in `.env` (git-ignored).
- Connect ONLY to the DEV database through `APP_DB_URL` (the limited `app_backend` role). Production credentials are not in
  this folder. If you ever find production credentials or an admin/`postgres` URL here, STOP and tell me.
- Ask before any destructive or schema-changing command (DROP, TRUNCATE, DELETE without WHERE, ALTER on existing data).
- Schema changes go in a NEW numbered file `db/migrations/NNN_description.sql`, applied to dev first. Do not rewrite
  `db/schema.sql`. After any schema change, `db/supabase_hardening.sql` must be re-run (it is safe to re-run).
- Never `git push` without asking me. Commit after each working step with a clear message.

## Rules the code must respect (the database also enforces most of these)
- Money is `numeric(12,2)` in INR. Never use floating-point numbers for money in code; use a decimal library or integer paise.
- Stock on hand and paid/balance are DERIVED (views). Never store or hand-edit them.
- Shipping goes through the `ship_items` / `ship_orders` / `ship_order` / `ship_available` database functions (atomic).
  Stock leaves only when goods ship. Shipping is charged per shipment.
- `inventory_movement` is append-only: correct mistakes with a new, reversing Adjustment (reason and user required).
- NO cancellations, returns or refunds. Do not build them.
- Keep business codes (SKU, SO_, PO_, TRAN_, CS_, CUST, SPLR) as unique text; never renumber existing ones.
- Use parameterised SQL only. No string-built queries.
- Keep login/authentication behind one small module (we may move to Amazon Cognito on AWS later).
- Config only from environment variables (the app must run unchanged on AWS later).

## How to work with me
- I am new to web development. Explain choices briefly in plain language, work in small steps, one feature at a time,
  and tell me exactly how to run and test each step. Use Plan mode first for each new feature.
- Plain-English error messages for users (for example "Not enough stock: only 1 left"), never raw database errors.
- Mobile-friendly screens (the owner may use a phone).

## Commands (update as they are created)
- Install: (to be filled in)
- Run dev server: (to be filled in)
- Run tests: (to be filled in)
