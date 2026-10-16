-- =====================================================================
-- Nadhi's Couture - PostgreSQL schema  (v0.1, Phase 1)
-- Plain PostgreSQL only: no Supabase-specific features, so it runs
-- unchanged on Supabase, AWS RDS/Aurora, or any other PostgreSQL 13+.
--
-- Conventions
--   * All money is INR, numeric(12,2). Currency is implied, not stored.
--   * Internal primary keys are UUIDs. Your business codes (SKU, PO_...,
--     SO_..., TRAN_..., SPLR..., CUST...) are kept as UNIQUE text columns.
--   * Dates are DATE; event times are timestamptz (display in Asia/Kolkata).
--   * Stock on hand is never stored. It is the SUM of inventory_movement.
--   * Paid / balance / payment state are never stored. They are derived
--     from payment_transaction (see the views at the bottom).
-- Run with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
-- =====================================================================

-- ---------- helper: keep updated_at current ----------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------- controlled-value (lookup) tables ----------
CREATE TABLE size_ref (
  code       text PRIMARY KEY CHECK (code = btrim(code) AND code <> ''),
  sort_order int  NOT NULL UNIQUE
);
CREATE TABLE colour_ref (
  name text PRIMARY KEY CHECK (name = btrim(name) AND name <> '')
);
CREATE TABLE fabric_ref (
  name text PRIMARY KEY CHECK (name = btrim(name) AND name <> '')
);
CREATE TABLE purchase_type_ref (
  name          text PRIMARY KEY CHECK (name = btrim(name) AND name <> ''),
  affects_stock boolean NOT NULL DEFAULT false  -- true = receipts add inventory
);
CREATE TABLE payment_method_ref (
  name text PRIMARY KEY CHECK (name = btrim(name) AND name <> '')
);

-- ---------- parties ----------
CREATE TABLE supplier (
  supplier_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_code  text NOT NULL UNIQUE CHECK (supplier_code = btrim(supplier_code) AND supplier_code <> ''),
  name           text NOT NULL,
  contact_person text,
  phone          text CHECK (phone IS NULL OR phone ~ '^[0-9+ ()-]{6,20}$'),  -- text, never numeric
  email          text,
  location       text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX supplier_phone_uq ON supplier (phone) WHERE phone IS NOT NULL;

CREATE TABLE customer (
  customer_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code text NOT NULL UNIQUE CHECK (customer_code = btrim(customer_code) AND customer_code <> ''),
  name          text NOT NULL,
  phone         text CHECK (phone IS NULL OR phone ~ '^[0-9+ ()-]{6,20}$'),
  email         text,
  location      text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_phone_uq ON customer (phone) WHERE phone IS NOT NULL;

-- ---------- catalogue ----------
CREATE TABLE product (
  product_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE CHECK (name = btrim(name) AND name <> ''),
  product_code text UNIQUE,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_variant (
  variant_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid NOT NULL REFERENCES product(product_id),
  sku                 text NOT NULL UNIQUE CHECK (sku = btrim(sku) AND sku <> ''),
  fabric              text NOT NULL REFERENCES fabric_ref(name)  ON UPDATE CASCADE,
  size                text NOT NULL REFERENCES size_ref(code)    ON UPDATE CASCADE,
  colour              text NOT NULL REFERENCES colour_ref(name)  ON UPDATE CASCADE,
  unit_cost           numeric(12,2) NOT NULL CHECK (unit_cost  >= 0),  -- wholesale purchase cost
  list_price          numeric(12,2) NOT NULL CHECK (list_price >= 0),  -- retail (est. selling) price
  default_supplier_id uuid REFERENCES supplier(supplier_id),           -- convenience only; real sourcing is on purchase lines
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, fabric, size, colour)
);
CREATE INDEX product_variant_product_ix ON product_variant (product_id);

-- ---------- purchasing ----------
CREATE TABLE purchase_order (
  purchase_order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_code           text NOT NULL UNIQUE CHECK (po_code = btrim(po_code) AND po_code <> ''),
  supplier_id       uuid NOT NULL REFERENCES supplier(supplier_id),
  order_date        date NOT NULL,
  purchase_type     text NOT NULL REFERENCES purchase_type_ref(name) ON UPDATE CASCADE,
  total_amount      numeric(12,2) NOT NULL CHECK (total_amount >= 0),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_order_supplier_ix ON purchase_order (supplier_id);

-- One variant per row. Only meaningful for purchase types with affects_stock = true.
CREATE TABLE purchase_order_item (
  purchase_order_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id      uuid NOT NULL REFERENCES purchase_order(purchase_order_id),
  line_no                int  NOT NULL CHECK (line_no > 0),
  variant_id             uuid NOT NULL REFERENCES product_variant(variant_id),
  qty_ordered            int  NOT NULL CHECK (qty_ordered > 0),
  qty_received           int  NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost              numeric(12,2) NOT NULL CHECK (unit_cost >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, line_no)
);
CREATE INDEX purchase_order_item_variant_ix ON purchase_order_item (variant_id);

-- ---------- sales ----------
CREATE TABLE customer_order (
  order_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code       text NOT NULL UNIQUE CHECK (order_code = btrim(order_code) AND order_code <> ''),
  customer_id      uuid REFERENCES customer(customer_id),               -- NULL allowed for guest sales
  order_date       date NOT NULL,
  status           text NOT NULL DEFAULT 'Pending'
                   CHECK (status IN ('Pending','Partially Shipped','Shipped','Delivered')),   -- no cancellations or returns
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_order_customer_ix ON customer_order (customer_id);
CREATE INDEX customer_order_date_ix     ON customer_order (order_date);

CREATE TABLE order_item (
  order_item_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES customer_order(order_id),
  line_no            int  NOT NULL CHECK (line_no > 0),
  variant_id         uuid NOT NULL REFERENCES product_variant(variant_id),
  quantity           int  NOT NULL CHECK (quantity > 0),
  unit_price         numeric(12,2) NOT NULL CHECK (unit_price >= 0),   -- snapshot at sale time
  discount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  unit_cost_snapshot numeric(12,2) NOT NULL CHECK (unit_cost_snapshot >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, line_no),
  CHECK (discount <= quantity * unit_price)
);
CREATE INDEX order_item_variant_ix ON order_item (variant_id);

-- ---------- money movements ----------
CREATE TABLE payment_transaction (
  transaction_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_code        text NOT NULL UNIQUE CHECK (transaction_code = btrim(transaction_code) AND transaction_code <> ''),
  txn_date                date NOT NULL,
  direction               text NOT NULL CHECK (direction IN ('In','Out')),
  amount                  numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method          text REFERENCES payment_method_ref(name) ON UPDATE CASCADE,
  payment_status          text NOT NULL DEFAULT 'Completed'
                          CHECK (payment_status IN ('Completed','Pending','Failed')),
  purchase_order_id       uuid REFERENCES purchase_order(purchase_order_id),
  order_id                uuid REFERENCES customer_order(order_id),
  legacy_status           text,                          -- original value from the old sheet
  is_migration_adjustment boolean NOT NULL DEFAULT false,
  note                    text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- exactly one parent, and the direction follows it: customers pay us ('In') for orders, we pay ('Out') for
  -- purchases. No refunds are supported (by decision).
  CHECK ((order_id IS NOT NULL AND purchase_order_id IS NULL AND direction = 'In')
      OR (purchase_order_id IS NOT NULL AND order_id IS NULL AND direction = 'Out'))
);
CREATE INDEX payment_po_ix    ON payment_transaction (purchase_order_id);
CREATE INDEX payment_order_ix ON payment_transaction (order_id);
CREATE INDEX payment_date_ix  ON payment_transaction (txn_date);

-- ---------- shipping ----------
-- Customers are charged shipping PER SHIPMENT (shipment.shipping_charged), billed on one of the orders in the
-- parcel (billed_order_id) and paid with that order's payments; you pay the courier
-- as one lump sum at month end. A courier_settlement is that lump-sum payment.
-- A shipment is "paid to courier" once it is linked to a settlement.
CREATE TABLE courier_settlement (
  settlement_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_code     text NOT NULL UNIQUE,
  courier_supplier_id uuid NOT NULL REFERENCES supplier(supplier_id),
  period_month        date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date), -- 1st of month covered
  paid_on             date NOT NULL,
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),   -- what was actually paid
  payment_method      text REFERENCES payment_method_ref(name) ON UPDATE CASCADE,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, courier_supplier_id)
);

CREATE SEQUENCE shipment_code_seq;

CREATE TABLE shipment (
  shipment_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_code         text NOT NULL UNIQUE DEFAULT ('SH_' || lpad(nextval('shipment_code_seq')::text, 7, '0')),
  courier_supplier_id   uuid NOT NULL REFERENCES supplier(supplier_id),
  tracking_number       text,
  shipment_status       text NOT NULL DEFAULT 'Shipped'
                        CHECK (shipment_status IN ('Shipped','In Transit','Delivered')),
  shipped_on            date NOT NULL,
  delivered_on          date,
  courier_cost          numeric(12,2) NOT NULL DEFAULT 0 CHECK (courier_cost >= 0),  -- what the courier charges you
  shipping_charged      numeric(12,2) NOT NULL DEFAULT 0 CHECK (shipping_charged >= 0), -- what the customer is charged
  billed_order_id       uuid NOT NULL REFERENCES customer_order(order_id),             -- order that carries this charge
  courier_settlement_id uuid,                                                        -- NULL = not yet paid to courier
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (delivered_on IS NULL OR delivered_on >= shipped_on),
  CHECK (shipment_status <> 'Delivered' OR delivered_on IS NOT NULL),
  -- a shipment can only be settled by a settlement with the SAME courier
  FOREIGN KEY (courier_settlement_id, courier_supplier_id)
    REFERENCES courier_settlement (settlement_id, courier_supplier_id)
);
CREATE INDEX shipment_billed_order_ix ON shipment (billed_order_id);
CREATE INDEX shipment_settlement_ix ON shipment (courier_settlement_id);
CREATE INDEX shipment_shipped_on_ix ON shipment (shipped_on);

-- A shipment is one PARCEL. It carries order LINES with quantities, so:
--   * one order can ship in several parcels (ship what is available now, the rest when restocked), and
--   * one parcel can carry lines from several orders of the SAME customer.
CREATE TABLE shipment_item (
  shipment_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id      uuid NOT NULL REFERENCES shipment(shipment_id),
  order_item_id    uuid NOT NULL REFERENCES order_item(order_item_id),
  quantity         int  NOT NULL CHECK (quantity > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, order_item_id)
);
CREATE INDEX shipment_item_order_item_ix ON shipment_item (order_item_id);

-- Never ship more than was ordered (across all parcels); one parcel = one customer.
CREATE FUNCTION check_shipment_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ordered int; already int; new_order uuid; new_cust uuid; other record;
BEGIN
  SELECT i.quantity, i.order_id, o.customer_id INTO ordered, new_order, new_cust
    FROM order_item i JOIN customer_order o ON o.order_id = i.order_id
   WHERE i.order_item_id = NEW.order_item_id FOR UPDATE OF i;   -- serialises concurrent shipments of this line
  SELECT COALESCE(SUM(quantity), 0) INTO already FROM shipment_item
   WHERE order_item_id = NEW.order_item_id AND shipment_item_id <> NEW.shipment_item_id;
  IF already + NEW.quantity > ordered THEN
    RAISE EXCEPTION 'Cannot ship % units of this order line: ordered %, already shipped %', NEW.quantity, ordered, already
      USING ERRCODE = 'check_violation';
  END IF;
  FOR other IN
    SELECT DISTINCT o2.order_id, o2.customer_id
      FROM shipment_item si
      JOIN order_item i2 ON i2.order_item_id = si.order_item_id
      JOIN customer_order o2 ON o2.order_id = i2.order_id
     WHERE si.shipment_id = NEW.shipment_id AND si.shipment_item_id <> NEW.shipment_item_id
  LOOP
    IF (new_cust IS NULL AND other.order_id <> new_order)
       OR (new_cust IS NOT NULL AND other.customer_id IS DISTINCT FROM new_cust) THEN
      RAISE EXCEPTION 'A parcel can only carry items for one customer' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_check_shipment_item BEFORE INSERT OR UPDATE OF quantity, order_item_id ON shipment_item
  FOR EACH ROW EXECUTE FUNCTION check_shipment_item();

-- The order billed for a parcel's shipping must have at least one line in that parcel
-- (checked at commit, so the parcel and its lines can be created in either order within one transaction).
CREATE FUNCTION check_shipment_billed_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shipment_item si JOIN order_item i ON i.order_item_id = si.order_item_id
                  WHERE si.shipment_id = NEW.shipment_id AND i.order_id = NEW.billed_order_id) THEN
    RAISE EXCEPTION 'Shipment %: billed order must have an item in the parcel', NEW.shipment_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_shipment_billed_order AFTER INSERT OR UPDATE OF billed_order_id ON shipment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shipment_billed_order();

-- An order line's quantity can't be edited below what has already shipped.
CREATE FUNCTION check_order_item_qty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity < (SELECT COALESCE(SUM(quantity), 0) FROM shipment_item WHERE order_item_id = NEW.order_item_id) THEN
    RAISE EXCEPTION 'Quantity cannot be lower than the units already shipped' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_order_item_qty BEFORE UPDATE OF quantity ON order_item
  FOR EACH ROW EXECUTE FUNCTION check_order_item_qty();

-- General overheads that are not tied to a PO or an order.
CREATE TABLE expense (
  expense_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_code           text UNIQUE,
  expense_date           date NOT NULL,
  category               text NOT NULL,
  amount                 numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_transaction_id uuid REFERENCES payment_transaction(transaction_id),
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ---------- inventory ledger (append-only) ----------
CREATE TABLE inventory_movement (
  movement_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id             uuid NOT NULL REFERENCES product_variant(variant_id),
  movement_type          text NOT NULL
                         CHECK (movement_type IN ('Opening Balance','Purchase Receipt','Sale Shipped','Adjustment')),
  quantity               int  NOT NULL CHECK (quantity <> 0),   -- signed: + adds stock, - removes
  moved_at               timestamptz NOT NULL DEFAULT now(),
  purchase_order_item_id uuid REFERENCES purchase_order_item(purchase_order_item_id),
  shipment_item_id       uuid REFERENCES shipment_item(shipment_item_id),   -- the shipped line that caused a sale/return
  reason                 text,
  created_by             text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (movement_type <> 'Adjustment' OR (reason IS NOT NULL AND created_by IS NOT NULL))
);
CREATE INDEX inventory_movement_variant_ix ON inventory_movement (variant_id);
-- a shipped line can be deducted from stock only once
CREATE UNIQUE INDEX inventory_one_sale_per_shipment_item_uq
  ON inventory_movement (shipment_item_id) WHERE movement_type = 'Sale Shipped';

-- Stock can never go negative, even if two people ship the last unit at once.
CREATE FUNCTION prevent_negative_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.variant_id::text, 0));  -- serialise per variant
  SELECT COALESCE(SUM(quantity), 0) + NEW.quantity INTO bal
    FROM inventory_movement WHERE variant_id = NEW.variant_id;
  IF bal < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for variant %: balance would become %', NEW.variant_id, bal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_no_negative_stock BEFORE INSERT ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION prevent_negative_stock();

-- History is never edited: correct mistakes with a new, reversing movement.
CREATE FUNCTION block_movement_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movement is append-only; add a reversing movement instead';
END $$;
CREATE TRIGGER trg_movement_append_only BEFORE UPDATE OR DELETE ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION block_movement_change();

-- updated_at triggers
CREATE TRIGGER trg_upd_supplier  BEFORE UPDATE ON supplier         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_customer  BEFORE UPDATE ON customer         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_product   BEFORE UPDATE ON product          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_variant   BEFORE UPDATE ON product_variant  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_po        BEFORE UPDATE ON purchase_order   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_order     BEFORE UPDATE ON customer_order   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_shipment  BEFORE UPDATE ON shipment         FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Order status follows what has shipped: nothing = Pending, some = Partially Shipped, all = Shipped.
CREATE FUNCTION refresh_order_shipping_status(p_order_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ordered bigint; shipped bigint;
BEGIN
  SELECT COALESCE(SUM(i.quantity), 0), COALESCE(SUM(x.q), 0) INTO ordered, shipped
    FROM order_item i
    LEFT JOIN LATERAL (SELECT SUM(quantity) AS q FROM shipment_item si WHERE si.order_item_id = i.order_item_id) x ON true
   WHERE i.order_id = p_order_id;
  UPDATE customer_order
     SET status = CASE WHEN shipped = 0 THEN 'Pending'
                       WHEN shipped < ordered THEN 'Partially Shipped'
                       ELSE 'Shipped' END
   WHERE order_id = p_order_id AND status IN ('Pending', 'Partially Shipped', 'Shipped');
END $$;

-- An order becomes Delivered when it is fully shipped AND every parcel carrying its items is Delivered.
CREATE FUNCTION sync_order_delivered() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shipment_status = 'Delivered' AND OLD.shipment_status <> 'Delivered' THEN
    UPDATE customer_order o SET status = 'Delivered'
     WHERE o.status = 'Shipped'
       AND o.order_id IN (SELECT i.order_id FROM shipment_item si
                          JOIN order_item i ON i.order_item_id = si.order_item_id
                          WHERE si.shipment_id = NEW.shipment_id)
       AND NOT EXISTS (SELECT 1 FROM shipment_item si2
                       JOIN order_item i2 ON i2.order_item_id = si2.order_item_id
                       JOIN shipment s2 ON s2.shipment_id = si2.shipment_id
                       WHERE i2.order_id = o.order_id AND s2.shipment_status <> 'Delivered');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_shipment_delivered AFTER UPDATE OF shipment_status ON shipment
  FOR EACH ROW EXECUTE FUNCTION sync_order_delivered();

-- ---------- business rule: stock leaves inventory only when goods SHIP ----------
-- ship_items: the core function. p_lines = JSON array like
--   [{"order_item_id": "<uuid>", "quantity": 1}, ...]
-- In ONE atomic step it creates the parcel, adds the lines, deducts stock for each, and updates each
-- order's status (Pending -> Partially Shipped -> Shipped). Lines may come from several orders but all
-- must be for the same customer. If any line lacks stock, or exceeds what was ordered, EVERYTHING rolls back.
-- p_shipping_charge is what the customer is charged for THIS parcel; it is billed on p_bill_order_id
-- (default: the earliest order in the parcel). Returns the new shipment_id.
CREATE FUNCTION ship_items(
  p_lines jsonb, p_courier_supplier_id uuid, p_shipped_on date DEFAULT CURRENT_DATE,
  p_courier_cost numeric DEFAULT 0, p_tracking_number text DEFAULT NULL, p_user text DEFAULT NULL,
  p_shipping_charge numeric DEFAULT 0, p_bill_order_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE ln record; o customer_order%ROWTYPE; oi order_item%ROWTYPE; sid uuid; sitem uuid; oid uuid;
        order_ids uuid[]; bill uuid;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'No items given to ship';
  END IF;
  SELECT array_agg(DISTINCT i.order_id) INTO order_ids
    FROM jsonb_array_elements(p_lines) e JOIN order_item i ON i.order_item_id = (e->>'order_item_id')::uuid;
  IF order_ids IS NULL THEN RAISE EXCEPTION 'Order line not found'; END IF;
  IF p_bill_order_id IS NOT NULL THEN
    IF NOT (p_bill_order_id = ANY (order_ids)) THEN
      RAISE EXCEPTION 'The billed order must be one of the orders in this parcel';
    END IF;
    bill := p_bill_order_id;
  ELSE
    SELECT c.order_id INTO bill FROM customer_order c WHERE c.order_id = ANY (order_ids)
     ORDER BY c.order_date, c.order_code LIMIT 1;
  END IF;
  INSERT INTO shipment (courier_supplier_id, tracking_number, shipped_on, courier_cost, shipping_charged, billed_order_id)
  VALUES (p_courier_supplier_id, p_tracking_number, p_shipped_on, p_courier_cost, p_shipping_charge, bill)
  RETURNING shipment_id INTO sid;
  FOR ln IN SELECT (e->>'order_item_id')::uuid AS order_item_id, (e->>'quantity')::int AS qty
              FROM jsonb_array_elements(p_lines) e ORDER BY 1 LOOP        -- fixed order avoids deadlocks
    SELECT * INTO oi FROM order_item WHERE order_item_id = ln.order_item_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order line % not found', ln.order_item_id; END IF;
    SELECT * INTO o FROM customer_order WHERE order_id = oi.order_id FOR UPDATE;
    IF o.status NOT IN ('Pending', 'Partially Shipped') THEN
      RAISE EXCEPTION 'Order % is % and cannot be shipped', o.order_code, o.status;
    END IF;
    IF p_shipped_on < o.order_date THEN
      RAISE EXCEPTION 'Ship date % is before order date % for %', p_shipped_on, o.order_date, o.order_code;
    END IF;
    INSERT INTO shipment_item (shipment_id, order_item_id, quantity)
    VALUES (sid, ln.order_item_id, ln.qty) RETURNING shipment_item_id INTO sitem;
    INSERT INTO inventory_movement (variant_id, movement_type, quantity, moved_at, shipment_item_id, reason, created_by)
    VALUES (oi.variant_id, 'Sale Shipped', -ln.qty, p_shipped_on::timestamp AT TIME ZONE 'Asia/Kolkata', sitem,
            'Order ' || o.order_code || ' line ' || oi.line_no || ' shipped', p_user);
  END LOOP;
  FOR oid IN SELECT DISTINCT i.order_id FROM shipment_item si
              JOIN order_item i ON i.order_item_id = si.order_item_id WHERE si.shipment_id = sid LOOP
    PERFORM refresh_order_shipping_status(oid);
  END LOOP;
  RETURN sid;
END $$;

-- Ship EVERYTHING still unshipped on the given orders (same customer) in one parcel.
CREATE FUNCTION ship_orders(
  p_order_ids uuid[], p_courier_supplier_id uuid, p_shipped_on date DEFAULT CURRENT_DATE,
  p_courier_cost numeric DEFAULT 0, p_tracking_number text DEFAULT NULL, p_user text DEFAULT NULL,
  p_shipping_charge numeric DEFAULT 0, p_bill_order_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE lines jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('order_item_id', i.order_item_id, 'quantity', i.quantity - COALESCE(x.q, 0)))
    INTO lines
    FROM order_item i
    LEFT JOIN LATERAL (SELECT SUM(quantity) AS q FROM shipment_item si WHERE si.order_item_id = i.order_item_id) x ON true
   WHERE i.order_id = ANY (p_order_ids) AND i.quantity - COALESCE(x.q, 0) > 0;
  IF lines IS NULL THEN RAISE EXCEPTION 'Nothing left to ship on these orders'; END IF;
  RETURN ship_items(lines, p_courier_supplier_id, p_shipped_on, p_courier_cost, p_tracking_number, p_user,
                    p_shipping_charge, p_bill_order_id);
END $$;

-- Ship everything left on a single order in its own parcel.
CREATE FUNCTION ship_order(
  p_order_id uuid, p_courier_supplier_id uuid, p_shipped_on date DEFAULT CURRENT_DATE,
  p_courier_cost numeric DEFAULT 0, p_tracking_number text DEFAULT NULL, p_user text DEFAULT NULL,
  p_shipping_charge numeric DEFAULT 0)
RETURNS uuid LANGUAGE sql AS $$
  SELECT ship_orders(ARRAY[p_order_id], p_courier_supplier_id, p_shipped_on, p_courier_cost, p_tracking_number,
                     p_user, p_shipping_charge, p_order_id)
$$;

-- Ship whatever is IN STOCK right now on one order (partial shipment); the rest stays to ship later.
CREATE FUNCTION ship_available(
  p_order_id uuid, p_courier_supplier_id uuid, p_shipped_on date DEFAULT CURRENT_DATE,
  p_courier_cost numeric DEFAULT 0, p_tracking_number text DEFAULT NULL, p_user text DEFAULT NULL,
  p_shipping_charge numeric DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE lines jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('order_item_id', f.order_item_id, 'quantity', f.can_ship_now))
    INTO lines FROM order_fulfilment f
   WHERE f.order_id = p_order_id AND f.can_ship_now > 0;
  IF lines IS NULL THEN RAISE EXCEPTION 'Nothing on this order is in stock right now'; END IF;
  RETURN ship_items(lines, p_courier_supplier_id, p_shipped_on, p_courier_cost, p_tracking_number, p_user,
                    p_shipping_charge, p_order_id);
END $$;

-- ---------- derived views (replace the old Available stock / Balance columns) ----------
CREATE VIEW inventory_balance AS
SELECT v.variant_id, v.sku, p.name AS product_name, v.fabric, v.size, v.colour,
       v.unit_cost, v.list_price,
       COALESCE(SUM(m.quantity), 0)::int AS on_hand
FROM product_variant v
JOIN product p ON p.product_id = v.product_id
LEFT JOIN inventory_movement m ON m.variant_id = v.variant_id
GROUP BY v.variant_id, v.sku, p.name, v.fabric, v.size, v.colour, v.unit_cost, v.list_price;

CREATE VIEW purchase_order_summary AS
SELECT po.purchase_order_id, po.po_code, s.name AS supplier, po.order_date, po.purchase_type,
       po.total_amount,
       COALESCE(pay.net_paid, 0) AS paid,
       po.total_amount - COALESCE(pay.net_paid, 0) AS balance,
       CASE WHEN COALESCE(pay.net_paid, 0) = 0                THEN 'Unpaid'
            WHEN COALESCE(pay.net_paid, 0) < po.total_amount  THEN 'Partial'
            WHEN COALESCE(pay.net_paid, 0) = po.total_amount  THEN 'Paid'
            ELSE 'Overpaid' END AS payment_state
FROM purchase_order po
JOIN supplier s ON s.supplier_id = po.supplier_id
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS net_paid
  FROM payment_transaction t
  WHERE t.purchase_order_id = po.purchase_order_id AND t.payment_status = 'Completed'
) pay ON true;

-- profit = items sold (after discount) - wholesale unit cost. Shipping is a pass-through (see shipment_summary).
-- Shipping is charged per shipment and billed on one order of the parcel, so an order's amount due grows
-- as its parcels ship. Money received before the goods ship shows as 'Advance'.
CREATE VIEW order_summary AS
SELECT o.order_id, o.order_code, o.order_date, o.status, c.name AS customer,
       COALESCE(li.ordered_qty, 0)::int                         AS ordered_qty,
       COALESCE(sh.shipped_qty, 0)::int                         AS shipped_qty,
       sh.shipment_codes, sh.first_shipped_on, sh.last_shipped_on,
       COALESCE(li.items_total, 0)                              AS items_total,
       COALESCE(bill.shipping_charged, 0)                       AS shipping_charged,
       COALESCE(li.items_total, 0) + COALESCE(bill.shipping_charged, 0) AS order_total,
       COALESCE(pay.received, 0)                                AS received,
       COALESCE(li.items_total, 0) + COALESCE(bill.shipping_charged, 0) - COALESCE(pay.received, 0) AS balance,
       CASE WHEN COALESCE(pay.received, 0) = 0 THEN 'Unpaid'
            WHEN COALESCE(pay.received, 0) < COALESCE(li.items_total, 0) + COALESCE(bill.shipping_charged, 0) THEN 'Partial'
            WHEN COALESCE(pay.received, 0) = COALESCE(li.items_total, 0) + COALESCE(bill.shipping_charged, 0) THEN 'Paid'
            WHEN o.status IN ('Pending', 'Partially Shipped') THEN 'Advance'
            ELSE 'Overpaid' END                                 AS payment_state,
       COALESCE(li.product_cost, 0)                             AS product_cost,
       COALESCE(li.items_total, 0) - COALESCE(li.product_cost, 0) AS profit
FROM customer_order o
LEFT JOIN customer c ON c.customer_id = o.customer_id
LEFT JOIN LATERAL (
  SELECT SUM(quantity)                         AS ordered_qty,
         SUM(quantity * unit_price - discount) AS items_total,
         SUM(quantity * unit_cost_snapshot)    AS product_cost
  FROM order_item i WHERE i.order_id = o.order_id
) li ON true
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS received
  FROM payment_transaction t
  WHERE t.order_id = o.order_id AND t.payment_status = 'Completed'
) pay ON true
LEFT JOIN LATERAL (
  SELECT SUM(shipping_charged) AS shipping_charged FROM shipment s WHERE s.billed_order_id = o.order_id
) bill ON true
LEFT JOIN LATERAL (
  SELECT SUM(si.quantity) AS shipped_qty, string_agg(DISTINCT s.shipment_code, ', ') AS shipment_codes,
         MIN(s.shipped_on) AS first_shipped_on, MAX(s.shipped_on) AS last_shipped_on
  FROM shipment_item si
  JOIN shipment s     ON s.shipment_id = si.shipment_id
  JOIN order_item i2  ON i2.order_item_id = si.order_item_id
  WHERE i2.order_id = o.order_id
) sh ON true;

-- One row per parcel: what the customer is charged vs what the courier charges you.
CREATE VIEW shipment_summary AS
SELECT s.shipment_id, s.shipment_code, ord.orders, ord.customer, bo.order_code AS billed_order, cr.name AS courier,
       s.tracking_number, s.shipment_status, s.shipped_on, s.delivered_on, ord.units::int AS units,
       s.shipping_charged, s.courier_cost, s.shipping_charged - s.courier_cost AS shipping_margin,
       CASE WHEN s.courier_settlement_id IS NULL THEN 'Unpaid' ELSE 'Paid' END AS courier_payment_state,
       cs.settlement_code, cs.paid_on AS courier_paid_on
FROM shipment s
JOIN supplier cr       ON cr.supplier_id = s.courier_supplier_id
JOIN customer_order bo ON bo.order_id = s.billed_order_id
LEFT JOIN courier_settlement cs ON cs.settlement_id = s.courier_settlement_id
LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT o.order_code, ', ') AS orders,
         string_agg(DISTINCT c.name, ', ')       AS customer,
         SUM(si.quantity)                        AS units
  FROM shipment_item si
  JOIN order_item i     ON i.order_item_id = si.order_item_id
  JOIN customer_order o ON o.order_id = i.order_id
  LEFT JOIN customer c  ON c.customer_id = o.customer_id
  WHERE si.shipment_id = s.shipment_id
) ord ON true;

-- What is inside each parcel.
CREATE VIEW shipment_line_detail AS
SELECT s.shipment_code, s.shipped_on, o.order_code, i.line_no, v.sku, p.name AS product, si.quantity
FROM shipment_item si
JOIN shipment s       ON s.shipment_id = si.shipment_id
JOIN order_item i     ON i.order_item_id = si.order_item_id
JOIN customer_order o ON o.order_id = i.order_id
JOIN product_variant v ON v.variant_id = i.variant_id
JOIN product p        ON p.product_id = v.product_id;

-- Per order line: ordered, shipped, still to ship, in stock, and what could ship right now.
CREATE VIEW order_fulfilment AS
SELECT o.order_id, o.order_code, o.status AS order_status, c.name AS customer,
       i.order_item_id, i.line_no, v.sku, p.name AS product,
       i.quantity AS ordered,
       COALESCE(x.q, 0)::int                                        AS shipped,
       (i.quantity - COALESCE(x.q, 0))::int                         AS remaining,
       b.on_hand,
       GREATEST(LEAST(i.quantity - COALESCE(x.q, 0), b.on_hand), 0)::int AS can_ship_now,
       GREATEST(i.quantity - COALESCE(x.q, 0) - b.on_hand, 0)::int  AS short_on_this_line
FROM order_item i
JOIN customer_order o  ON o.order_id = i.order_id
LEFT JOIN customer c   ON c.customer_id = o.customer_id
JOIN product_variant v ON v.variant_id = i.variant_id
JOIN product p         ON p.product_id = v.product_id
JOIN inventory_balance b ON b.variant_id = v.variant_id
LEFT JOIN LATERAL (SELECT SUM(quantity) AS q FROM shipment_item si WHERE si.order_item_id = i.order_item_id) x ON true;

-- What you still owe each courier, grouped by month of shipment (for the month-end payment).
CREATE VIEW courier_payable AS
SELECT cr.name AS courier, date_trunc('month', s.shipped_on)::date AS month,
       COUNT(*) AS shipments, SUM(s.courier_cost) AS amount_due
FROM shipment s JOIN supplier cr ON cr.supplier_id = s.courier_supplier_id
WHERE s.courier_settlement_id IS NULL
GROUP BY cr.name, date_trunc('month', s.shipped_on);

-- Does each month-end payment match the shipments it settles?
CREATE VIEW courier_settlement_summary AS
SELECT cs.settlement_id, cs.settlement_code, cr.name AS courier, cs.period_month, cs.paid_on,
       cs.amount AS amount_paid, COALESCE(x.due, 0) AS shipments_total,
       cs.amount - COALESCE(x.due, 0) AS difference,
       CASE WHEN cs.amount = COALESCE(x.due, 0) THEN 'Matches' ELSE 'Check' END AS reconciliation
FROM courier_settlement cs
JOIN supplier cr ON cr.supplier_id = cs.courier_supplier_id
LEFT JOIN LATERAL (SELECT SUM(courier_cost) AS due FROM shipment s WHERE s.courier_settlement_id = cs.settlement_id) x ON true;

-- What to buy: units customers are waiting for that stock cannot cover (open orders only).
CREATE VIEW purchase_needed AS
SELECT sku, product, SUM(remaining)::int AS units_waiting, MAX(on_hand) AS on_hand,
       (SUM(remaining) - MAX(on_hand))::int AS units_to_buy
FROM order_fulfilment
WHERE order_status IN ('Pending', 'Partially Shipped') AND remaining > 0
GROUP BY sku, product
HAVING SUM(remaining) > MAX(on_hand);

-- Shipping is pass-through: charged to customers vs charged by couriers, by month of shipment.
CREATE VIEW shipping_monthly AS
SELECT date_trunc('month', shipped_on)::date AS month,
       COUNT(*)                              AS shipments,
       SUM(shipping_charged)                 AS shipping_charged,
       SUM(courier_cost)                     AS courier_cost,
       SUM(shipping_charged) - SUM(courier_cost) AS shipping_margin
FROM shipment GROUP BY 1;
