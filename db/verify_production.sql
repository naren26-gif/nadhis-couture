-- =====================================================================
-- Nadhi's Couture - read-only checks after the production load + hardening.
-- Changes nothing. Run as the admin user (or app_backend) and compare with the workbook / reconciliation report:
--   psql $env:ADMIN_DB_URL -f db/verify_production.sql
-- Expected for the reviewed workbook: 4 suppliers, 3 customers, 55 variants, 6 POs, 4 orders, 3 shipments,
-- 11 payments, stock on hand 51, PO paid 25,312.00 of 25,312.00, courier owed 250.00.
-- =====================================================================

\echo '--- row counts ---'
SELECT 'supplier' AS tbl, count(*) FROM supplier
UNION ALL SELECT 'customer', count(*) FROM customer
UNION ALL SELECT 'product', count(*) FROM product
UNION ALL SELECT 'product_variant', count(*) FROM product_variant
UNION ALL SELECT 'purchase_order', count(*) FROM purchase_order
UNION ALL SELECT 'purchase_order_item', count(*) FROM purchase_order_item
UNION ALL SELECT 'customer_order', count(*) FROM customer_order
UNION ALL SELECT 'order_item', count(*) FROM order_item
UNION ALL SELECT 'shipment', count(*) FROM shipment
UNION ALL SELECT 'shipment_item', count(*) FROM shipment_item
UNION ALL SELECT 'payment_transaction', count(*) FROM payment_transaction
UNION ALL SELECT 'inventory_movement', count(*) FROM inventory_movement
UNION ALL SELECT 'app_user (want 0 until cutover)', count(*) FROM app_user;

\echo '--- stock (want total 51, none negative) ---'
SELECT sum(on_hand) AS total_on_hand, count(*) FILTER (WHERE on_hand < 0) AS negative_variants FROM inventory_balance;

\echo '--- purchases: total vs paid ---'
SELECT * FROM purchase_order_summary ORDER BY 1;

\echo '--- orders ---'
SELECT order_code, customer, status, order_total, received, balance, payment_state FROM order_summary ORDER BY order_code;

\echo '--- shipments and courier payable (want 250.00 owed) ---'
SELECT * FROM courier_payable;

\echo '--- objects from migrations 001-005 (every row should be true) ---'
SELECT 'app_user table' AS item, to_regclass('public.app_user') IS NOT NULL AS present
UNION ALL SELECT 'app_session table', to_regclass('public.app_session') IS NOT NULL
UNION ALL SELECT 'supplier_code_seq (002)', to_regclass('public.supplier_code_seq') IS NOT NULL
UNION ALL SELECT 'customer_code_seq (002)', to_regclass('public.customer_code_seq') IS NOT NULL
UNION ALL SELECT 'po_code_seq (003)', to_regclass('public.po_code_seq') IS NOT NULL
UNION ALL SELECT 'transaction_code_seq (003)', to_regclass('public.transaction_code_seq') IS NOT NULL
UNION ALL SELECT 'set_shipment_code() (005)', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_shipment_code');

\echo '--- locks: RLS on every table (want no rows listed) ---'
SELECT c.relname AS table_without_rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

\echo '--- API roles still holding table privileges (want no rows) ---'
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role');

\echo '--- app_backend must NOT have DELETE/TRUNCATE except on order_item and app_session (want no rows) ---'
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'app_backend'
  AND privilege_type IN ('DELETE', 'TRUNCATE')
  AND table_name NOT IN ('order_item', 'app_session');
