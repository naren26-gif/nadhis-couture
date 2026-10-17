-- =====================================================================
-- Migration 004: refunds of customer OVERPAYMENTS
--
-- Decision (owner): when a customer has paid more than their order is worth (for example the order was reduced after
-- payment), the shop must be able to record paying the surplus back. This is a narrow exception to "no refunds":
-- only the surplus can be refunded (the app enforces the cap), never goods, and a refund never cancels an order.
-- Cancellations and returns remain out of scope.
--
-- What changes
--   1. An order payment may now be 'In' (customer pays) OR 'Out' (a refund). A purchase payment must still be 'Out'.
--   2. A refund (an 'Out' payment on an order) must carry a reason in its note.
--   3. View order_summary: `received` is now NET (money in minus refunds). All existing columns keep their names, order
--      and types; two columns are APPENDED at the end: paid_in and refunded. Nothing that reads the view breaks.
-- No existing row changes (there are no 'Out' payments on orders yet, so every existing figure stays identical).
--
-- Apply to DEV first, as the admin (postgres) user. One transaction: if anything fails, nothing is applied.
--   psql $env:ADMIN_DB_URL -v ON_ERROR_STOP=1 -1 -f db/migrations/004_customer_refunds.sql
-- Then re-run db/supabase_hardening.sql (safe to re-run).
-- =====================================================================

-- 1. who can pay what, in which direction
ALTER TABLE payment_transaction DROP CONSTRAINT payment_transaction_check;
ALTER TABLE payment_transaction ADD CONSTRAINT payment_parent_and_direction_check CHECK (
     (order_id IS NOT NULL AND purchase_order_id IS NULL)                          -- order: 'In' = customer pays, 'Out' = refund
  OR (purchase_order_id IS NOT NULL AND order_id IS NULL AND direction = 'Out')    -- purchase: we always pay 'Out'
);

-- 2. a refund must say why
ALTER TABLE payment_transaction ADD CONSTRAINT refund_needs_reason CHECK (
  order_id IS NULL OR direction = 'In' OR (note IS NOT NULL AND btrim(note) <> '')
);

-- 3. order_summary: received = money in - refunds; paid_in and refunded appended at the end
CREATE OR REPLACE VIEW order_summary AS
SELECT o.order_id,
       o.order_code,
       o.order_date,
       o.status,
       c.name AS customer,
       COALESCE(li.ordered_qty, 0::bigint)::integer AS ordered_qty,
       COALESCE(sh.shipped_qty, 0::bigint)::integer AS shipped_qty,
       sh.shipment_codes,
       sh.first_shipped_on,
       sh.last_shipped_on,
       COALESCE(li.items_total, 0::numeric) AS items_total,
       COALESCE(bill.shipping_charged, 0::numeric) AS shipping_charged,
       COALESCE(li.items_total, 0::numeric) + COALESCE(bill.shipping_charged, 0::numeric) AS order_total,
       COALESCE(pay.received, 0::numeric) AS received,
       COALESCE(li.items_total, 0::numeric) + COALESCE(bill.shipping_charged, 0::numeric) - COALESCE(pay.received, 0::numeric) AS balance,
       CASE
         WHEN COALESCE(pay.received, 0::numeric) = 0::numeric THEN 'Unpaid'::text
         WHEN COALESCE(pay.received, 0::numeric) < (COALESCE(li.items_total, 0::numeric) + COALESCE(bill.shipping_charged, 0::numeric)) THEN 'Partial'::text
         WHEN COALESCE(pay.received, 0::numeric) = (COALESCE(li.items_total, 0::numeric) + COALESCE(bill.shipping_charged, 0::numeric)) THEN 'Paid'::text
         WHEN o.status = ANY (ARRAY['Pending'::text, 'Partially Shipped'::text]) THEN 'Advance'::text
         ELSE 'Overpaid'::text
       END AS payment_state,
       COALESCE(li.product_cost, 0::numeric) AS product_cost,
       COALESCE(li.items_total, 0::numeric) - COALESCE(li.product_cost, 0::numeric) AS profit,
       COALESCE(pay.paid_in, 0::numeric) AS paid_in,
       COALESCE(pay.refunded, 0::numeric) AS refunded
  FROM customer_order o
  LEFT JOIN customer c ON c.customer_id = o.customer_id
  LEFT JOIN LATERAL (
        SELECT sum(i.quantity) AS ordered_qty,
               sum(i.quantity::numeric * i.unit_price - i.discount) AS items_total,
               sum(i.quantity::numeric * i.unit_cost_snapshot) AS product_cost
          FROM order_item i
         WHERE i.order_id = o.order_id) li ON true
  LEFT JOIN LATERAL (
        SELECT sum(CASE WHEN t.direction = 'In' THEN t.amount ELSE -t.amount END) AS received,
               sum(t.amount) FILTER (WHERE t.direction = 'In') AS paid_in,
               sum(t.amount) FILTER (WHERE t.direction = 'Out') AS refunded
          FROM payment_transaction t
         WHERE t.order_id = o.order_id AND t.payment_status = 'Completed'::text) pay ON true
  LEFT JOIN LATERAL (
        SELECT sum(s.shipping_charged) AS shipping_charged
          FROM shipment s
         WHERE s.billed_order_id = o.order_id) bill ON true
  LEFT JOIN LATERAL (
        SELECT sum(si.quantity) AS shipped_qty,
               string_agg(DISTINCT s.shipment_code, ', '::text) AS shipment_codes,
               min(s.shipped_on) AS first_shipped_on,
               max(s.shipped_on) AS last_shipped_on
          FROM shipment_item si
          JOIN shipment s ON s.shipment_id = si.shipment_id
          JOIN order_item i2 ON i2.order_item_id = si.order_item_id
         WHERE i2.order_id = o.order_id) sh ON true;
