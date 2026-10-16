#!/usr/bin/env python3
"""
Nadhi's Couture - Excel -> PostgreSQL migration.

  python migrate.py --xlsx path/to/workbook.xlsx             # DRY RUN (default): writes nothing to any database
  python migrate.py --xlsx ... --load --dsn "$DATABASE_URL"  # real load, one transaction, rolls back on any failed check

A dry run reads the workbook, applies the approved corrections below, validates everything,
and writes a reconciliation report plus the cleaned tables as CSV into --out (default ./reports).
The source workbook is never modified.
"""
import argparse, csv, sys, uuid
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import openpyxl

# =====================================================================
# APPROVED CORRECTIONS & ASSUMPTIONS  (every judgement call lives here)
# =====================================================================
# (original SKU, original colour) -> corrected SKU.
SKU_FIXES = {
    ("UMRC-M-PK",  "Lavendar"): "UMRC-M-LV",    # approved: Lavender variants get suffix LV
    ("UMRC-L-PK",  "Lavendar"): "UMRC-L-LV",
    ("UMRC-XL-PK", "Lavendar"): "UMRC-XL-LV",
    ("UMV-M-YLW",  "Pink"):     "UMV-M-PK",     # approved: colour Pink is correct, SKU changes
    ("UMV-L-YLW",  "Pink"):     "UMV-L-PK",
}
COLOUR_FIXES = {"Lavendar": "Lavender"}          # spelling

ORDER_QTY_FIXES = {"SO_0000004": 1}              # approved: blank quantity is 1

# Approved: PO_0000002 is fully paid (2,660). Source records only 1,330; the balance 1,330 was paid on 16 Oct 2026.
# Payment method was not stated -> left blank.
EXTRA_PAYMENTS = [
    dict(code="TRAN_MIG_0001", po="PO_0000002", amount=Decimal("1330.00"), txn_date=date(2026, 10, 16), method="GPay",
         note="Added at migration: balance of PO_0000002, paid 16 Oct 2026 via GPay (confirmed by owner). "
              "Source sheet recorded only the first 1,330."),
]
# Approved: TRAN_00000009 (PO_0000005) is corrected from 580 to 1,130 (owner paid the extra 550 via GPay).
PAYMENT_AMOUNT_CORRECTIONS = {
    "TRAN_00000009": (Decimal("1130.00"),
                      "Amount corrected 580 -> 1,130 at migration: PO_0000005 also covered UMRC-2XL-BL (550); paid via GPay (confirmed by owner)."),
}

# Approved rule: order cost snapshot ALWAYS comes from the variant master Unit cost (wholesale purchase cost).
# profit = selling price - unit cost. The source sheet's own UnitCost for orders is ignored (shown in report as INFO).
COST_SNAPSHOT = "variant_master"
# Approved: all 4 shipments happened on 16 Oct 2026.
SHIPPED_ON_DATE = date(2026, 10, 16)
# Confirmed by owner: shipping is charged to the customer PER SHIPMENT; no courier payment has been made yet;
# there are no cancellations, returns or refunds.
# Confirmed by owner: ST Courier is the courier for all shipments.
COURIER_SUPPLIER_CODE = "SPLR0004"
# Confirmed by owner: these orders went out as ONE parcel (same customer). All other orders are one parcel each.
PARCEL_GROUPS = [["SO_0000003", "SO_0000004"]]
# Confirmed by owner: no payment has been made to ST Courier yet, so existing shipments are unpaid to the courier.

# Approved (owner): PO_0000005 was 580 + 550 - it covered BOTH UMRC-2XL-BL (550) and FDM-L-BLK (580); the sheet omitted the 550.
PO_TOTAL_CORRECTIONS = {"PO_0000005": Decimal("1130.00")}
# PO line items. PO_0000005 is stated by the owner. PO_0000001 gets every OTHER variant, by elimination: only these two
# POs are stock purchases, and the remaining 53 variants at master cost total exactly 20,550 = PO_0000001's total
# (the migration checks this tie; it fails the load if it ever stops tying).
PO_KNOWN_ITEMS = {"PO_0000005": ["UMRC-2XL-BL", "FDM-L-BLK"]}
PO_REMAINDER = "PO_0000001"

PURCHASE_TYPES_AFFECTING_STOCK = {"Wholesale Garments"}   # approved: all other purchase types do not touch inventory
SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"]
PAYMENT_STATUS_MAP = {"Done": "Completed", "Partial": "Completed"}   # 'Partial' described the PO, not the payment
DIRECTION_MAP = {"Income": "In", "Expense": "Out"}
IST = timezone(timedelta(hours=5, minutes=30))
NS = uuid.UUID("6f1c2b9e-5a3d-4c7e-9a10-4e6b1d2f8a01")  # fixed namespace -> reruns give identical IDs

TABLE_COLUMNS = {
    "size_ref": ["code", "sort_order"],
    "colour_ref": ["name"],
    "fabric_ref": ["name"],
    "purchase_type_ref": ["name", "affects_stock"],
    "payment_method_ref": ["name"],
    "supplier": ["supplier_id", "supplier_code", "name", "contact_person", "phone", "location"],
    "customer": ["customer_id", "customer_code", "name", "location"],
    "product": ["product_id", "name"],
    "product_variant": ["variant_id", "product_id", "sku", "fabric", "size", "colour", "unit_cost",
                        "list_price", "default_supplier_id"],
    "purchase_order": ["purchase_order_id", "po_code", "supplier_id", "order_date", "purchase_type", "total_amount"],
    "purchase_order_item": ["purchase_order_item_id", "purchase_order_id", "line_no", "variant_id", "qty_ordered",
                            "qty_received", "unit_cost"],
    "customer_order": ["order_id", "order_code", "customer_id", "order_date", "status"],
    "order_item": ["order_item_id", "order_id", "line_no", "variant_id", "quantity", "unit_price",
                   "discount", "unit_cost_snapshot"],
    "shipment": ["shipment_id", "shipment_code", "courier_supplier_id", "shipment_status",
                 "shipped_on", "courier_cost", "shipping_charged", "billed_order_id", "note"],
    "shipment_item": ["shipment_item_id", "shipment_id", "order_item_id", "quantity"],
    "payment_transaction": ["transaction_id", "transaction_code", "txn_date", "direction", "amount",
                            "payment_method", "payment_status", "purchase_order_id", "order_id",
                            "legacy_status", "is_migration_adjustment", "note"],
    "inventory_movement": ["movement_id", "variant_id", "movement_type", "quantity", "moved_at",
                           "shipment_item_id", "purchase_order_item_id", "reason", "created_by"],
}
LOAD_ORDER = ["size_ref", "colour_ref", "fabric_ref", "purchase_type_ref", "payment_method_ref",
              "supplier", "customer", "product", "product_variant", "purchase_order", "purchase_order_item",
              "customer_order", "order_item", "shipment", "shipment_item", "payment_transaction", "inventory_movement"]


# ---------------------------------------------------------------- helpers
def clean(v):
    return v.strip() if isinstance(v, str) else v

def money(v):
    return None if v is None else Decimal(str(v)).quantize(Decimal("0.01"))

def to_date(v):
    return v.date() if isinstance(v, datetime) else v

def phone_text(v):
    if v is None:
        return None
    return str(int(v)) if isinstance(v, (int, float)) else str(v).strip()

def uid(kind, key):
    return str(uuid.uuid5(NS, f"{kind}:{key}"))

def read_sheet(wb, name, key_col):
    ws = wb[name]
    rows = ws.iter_rows(values_only=True)
    header = [clean(h) for h in next(rows)]
    out = []
    for i, row in enumerate(rows, start=2):
        rec = {h: clean(v) for h, v in zip(header, row) if h is not None}
        if rec.get(key_col) in (None, ""):
            continue
        rec["_row"] = i
        out.append(rec)
    return out


# ---------------------------------------------------------------- transform
def build_model(xlsx):
    wb = openpyxl.load_workbook(xlsx, data_only=False)
    src = {
        "suppliers": read_sheet(wb, "SuppliersMaster", "SupplierID"),
        "customers": read_sheet(wb, "CustomersMaster", "CustomerID"),
        "products":  read_sheet(wb, "ProductMaster & Inventory", "SKU"),
        "pos":       read_sheet(wb, "PurchaseMaster", "PurchaseOrder"),
        "orders":    read_sheet(wb, "OrdersMaster", "OrderID"),
        "txns":      read_sheet(wb, "Expenses & Cash", "TransactionID"),
    }
    checks, notes, fixes_applied = [], [], []
    M = {t: [] for t in TABLE_COLUMNS}

    def check(status, name, detail=""):
        checks.append((status, name, detail))

    # --- suppliers / customers
    sup_id = {}
    for r in src["suppliers"]:
        sup_id[r["SupplierID"]] = uid("supplier", r["SupplierID"])
        M["supplier"].append(dict(supplier_id=sup_id[r["SupplierID"]], supplier_code=r["SupplierID"],
                                  name=r["SupplierName"], contact_person=r["POC"],
                                  phone=phone_text(r["ContactDetails"]), location=r["Location"]))
    cust_id = {}
    for r in src["customers"]:
        cust_id[r["CustomerID"]] = uid("customer", r["CustomerID"])
        M["customer"].append(dict(customer_id=cust_id[r["CustomerID"]], customer_code=r["CustomerID"],
                                  name=r["CustomerName"], location=r["Location"]))

    if COURIER_SUPPLIER_CODE not in sup_id:
        check("FAIL", "Courier supplier exists", f"{COURIER_SUPPLIER_CODE} not in SuppliersMaster")

    # --- products & variants (apply approved SKU/colour fixes)
    used_fixes = set()
    prod_id, variants, by_raw_sku = {}, {}, defaultdict(list)
    for r in src["products"]:
        raw_sku, raw_colour = r["SKU"], r["Colour"]
        colour = COLOUR_FIXES.get(raw_colour, raw_colour)
        sku = SKU_FIXES.get((raw_sku, raw_colour), raw_sku)
        if (raw_sku, raw_colour) in SKU_FIXES:
            used_fixes.add((raw_sku, raw_colour))
            fixes_applied.append(f"Row {r['_row']}: SKU {raw_sku} -> {sku}" + (f" (colour '{raw_colour}' -> '{colour}')" if colour != raw_colour else ""))
        elif colour != raw_colour:
            fixes_applied.append(f"Row {r['_row']}: colour '{raw_colour}' -> '{colour}'")
        name = r["Product name"]
        if name not in prod_id:
            prod_id[name] = uid("product", name)
            M["product"].append(dict(product_id=prod_id[name], name=name))
        if sku in variants:
            check("FAIL", "SKU unique after corrections", f"Duplicate SKU {sku} (row {r['_row']})")
            continue
        v = dict(variant_id=uid("variant", sku), product_id=prod_id[name], sku=sku, fabric=r["Fabric"],
                 size=r["Size"], colour=colour, unit_cost=money(r["Unit cost"]),
                 list_price=money(r["Est Selling price"]),
                 default_supplier_id=sup_id.get(r["Supplier"]),
                 _received=int(r["Units received"] or 0), _sold=int(r["Units sold"] or 0),
                 _adj=int(r["Adjustments"] or 0), _actual=money(r["Actual Selling Price"]), _row=r["_row"])
        if r["Supplier"] and r["Supplier"] not in sup_id:
            check("FAIL", "Variant supplier exists", f"{sku}: unknown supplier {r['Supplier']}")
        variants[sku] = v
        by_raw_sku[raw_sku].append(v)
        M["product_variant"].append(v)
    for k in set(SKU_FIXES) - used_fixes:
        check("FAIL", "Approved SKU fix still applies", f"{k} not found in source - source data changed?")
    if not any(c[0] == "FAIL" and c[1].startswith("SKU unique") for c in checks):
        check("PASS", "SKU unique after corrections", f"{len(variants)} variants, no duplicates")
    combos = Counter((v["product_id"], v["fabric"], v["size"], v["colour"]) for v in variants.values())
    dup_combo = [k for k, n in combos.items() if n > 1]
    check("FAIL" if dup_combo else "PASS", "Product+fabric+size+colour unique", f"{len(dup_combo)} duplicates")

    # --- reference tables derived from the data
    for z in sorted({v["size"] for v in variants.values()}, key=lambda s: SIZE_ORDER.index(s) if s in SIZE_ORDER else 99):
        if z not in SIZE_ORDER:
            check("FAIL", "Size known", f"Unknown size '{z}'")
    for z in SIZE_ORDER:
        M["size_ref"].append(dict(code=z, sort_order=SIZE_ORDER.index(z) + 1))
    for c in sorted({v["colour"] for v in variants.values()}):
        M["colour_ref"].append(dict(name=c))
    for f in sorted({v["fabric"] for v in variants.values()}):
        M["fabric_ref"].append(dict(name=f))
    for t in sorted({r["PurchaseType"] for r in src["pos"]}):
        M["purchase_type_ref"].append(dict(name=t, affects_stock=t in PURCHASE_TYPES_AFFECTING_STOCK))
    methods = sorted({r["PaymentMethod"] for r in src["txns"] if r.get("PaymentMethod")})
    for m in methods:
        M["payment_method_ref"].append(dict(name=m))

    # --- purchase orders
    po_id, po_total = {}, {}
    for r in src["pos"]:
        if r["SupplierID"] not in sup_id:
            check("FAIL", "PO supplier exists", f"{r['PurchaseOrder']}: unknown supplier {r['SupplierID']}")
            continue
        code = r["PurchaseOrder"]
        po_id[code] = uid("po", code)
        total = PO_TOTAL_CORRECTIONS.get(code, money(r["TotalPrice"]))
        if code in PO_TOTAL_CORRECTIONS:
            fixes_applied.append(f"{code}: total {money(r['TotalPrice'])} -> {total} (approved: PO also covered UMRC-2XL-BL at 550)")
        po_total[code] = total
        M["purchase_order"].append(dict(purchase_order_id=po_id[code], po_code=code,
                                        supplier_id=sup_id[r["SupplierID"]], order_date=to_date(r["PurchaseDate"]),
                                        purchase_type=r["PurchaseType"], total_amount=total))

    # --- orders (+ one order item each) ; payments first so shipping_charged can be derived
    order_id = {r["OrderID"]: uid("order", r["OrderID"]) for r in src["orders"]}
    received_by_order = defaultdict(Decimal)
    for r in src["txns"]:
        if r["Category"] == "Order" and r["Type"] == "Income":
            received_by_order[r["ReferenceID"]] += money(r["Amount"])
    order_rows, cost_compare = [], []
    for r in src["orders"]:
        code = r["OrderID"]
        if r["CustomerID"] not in cust_id:
            check("FAIL", "Order customer exists", f"{code}: unknown customer {r['CustomerID']}")
            continue
        cands = by_raw_sku.get(r["SKU"], [])
        if len(cands) != 1:
            check("FAIL", "Order SKU resolves to exactly one variant", f"{code}: SKU {r['SKU']} matches {len(cands)} variants")
            continue
        v = cands[0]
        qty = r["Quantity"] if r["Quantity"] is not None else ORDER_QTY_FIXES.get(code)
        if qty is None or int(qty) != qty or qty <= 0:
            check("FAIL", "Order quantity is a positive integer", f"{code}: quantity {r['Quantity']!r}")
            continue
        if r["Quantity"] is None:
            fixes_applied.append(f"{code}: blank Quantity -> {ORDER_QTY_FIXES[code]} (approved)")
        qty = int(qty)
        price, disc = money(r["SellingPricePerUnit"]), money(r["Discount"] or 0)
        items_total = qty * price - disc
        charged = max(Decimal("0.00"), received_by_order.get(code, Decimal("0")) - items_total)
        cost = v["unit_cost"] if COST_SNAPSHOT == "variant_master" else money(r["UnitCost"])
        sheet_cost = money(r["UnitCost"])
        d = to_date(r["OrderDate"])
        ship_cost = money(r["ShippingCost"] or 0)
        order_rows.append(dict(order_id=order_id[code], order_code=code, customer_id=cust_id[r["CustomerID"]],
                               order_date=d, status=r["OrderStatus"]))
        if charged != ship_cost:
            check("REVIEW", "Shipping collected from customer == sheet ShippingCost",
                  f"{code}: collected {charged} vs ShippingCost {ship_cost}")
        if r["OrderStatus"] == "Shipped" and SHIPPED_ON_DATE < d:
            check("FAIL", "Ship date not before order date", f"{code}: order {d}, shipped {SHIPPED_ON_DATE}")
        item = dict(order_item_id=uid("item", f"{code}:1"), order_id=order_id[code], line_no=1,
                    variant_id=v["variant_id"], quantity=qty, unit_price=price, discount=disc,
                    unit_cost_snapshot=cost, _sku=v["sku"])
        M["order_item"].append(item)
        cost_compare.append(dict(code=code, sku=v["sku"], sheet=sheet_cost, master=v["unit_cost"], used=cost,
                                 revenue=items_total, ship_cost=ship_cost, qty=qty,
                                 charged=charged))
        if v["_actual"] is not None and v["_actual"] != price:
            check("REVIEW", "Actual Selling Price matches order price", f"{v['sku']}: master {v['_actual']} vs order {price}")
    M["customer_order"] = order_rows
    items_by_order = {i["order_id"]: i for i in M["order_item"]}

    # --- shipments = parcels. Grouped orders share one parcel; every other shipped order is its own parcel.
    shipped = [o for o in M["customer_order"] if o["status"] == "Shipped"]
    cost_by_code = {c["code"]: c["ship_cost"] for c in cost_compare}
    by_code = {o["order_code"]: o for o in shipped}
    grouped = {c for g in PARCEL_GROUPS for c in g}
    parcels = []
    for o in shipped:
        if o["order_code"] in grouped:
            g = next(g for g in PARCEL_GROUPS if o["order_code"] in g)
            if g[0] == o["order_code"]:
                parcels.append(g)
        else:
            parcels.append([o["order_code"]])
    for g in PARCEL_GROUPS:
        missing = [c for c in g if c not in by_code]
        if missing:
            check("FAIL", "Parcel group orders exist and are Shipped", f"{missing}")
        elif len({by_code[c]["customer_id"] for c in g}) != 1:
            check("FAIL", "Orders in one parcel are for the same customer", f"{g}")
    for g in parcels:
        if any(c not in by_code for c in g):
            continue
        n = len(M["shipment"]) + 1
        sid = uid("shipment", "+".join(g))
        cost = sum((cost_by_code[c] for c in g), Decimal("0.00"))
        charge_by_code = {c["code"]: c["charged"] for c in cost_compare}
        charge = sum((charge_by_code[c] for c in g), Decimal("0.00"))
        billed = max(g, key=lambda c: charge_by_code[c])      # the order whose payment carried the shipping (first on ties)
        M["shipment"].append(dict(
            shipment_id=sid, shipment_code=f"SH_{n:07d}", courier_supplier_id=sup_id.get(COURIER_SUPPLIER_CODE),
            shipment_status="Shipped", shipped_on=SHIPPED_ON_DATE, courier_cost=cost,
            shipping_charged=charge, billed_order_id=by_code[billed]["order_id"],
            note=(f"One parcel for {' + '.join(g)} (confirmed by owner)" if len(g) > 1 else None)))
        for c in g:   # every order here ships in full: one shipment line per order line
            for it in M["order_item"]:
                if it["order_id"] == by_code[c]["order_id"]:
                    M["shipment_item"].append(dict(shipment_item_id=uid("shipitem", it["order_item_id"]),
                                                   shipment_id=sid, order_item_id=it["order_item_id"],
                                                   quantity=it["quantity"]))

    # --- payments
    order_codes, ok_txn = set(order_id), []
    for r in src["txns"]:
        ref, cat, typ = r["ReferenceID"], r["Category"], r["Type"]
        if typ not in DIRECTION_MAP:
            check("FAIL", "Transaction type known", f"{r['TransactionID']}: {typ}")
            continue
        po = po_id.get(ref) if cat == "Purchase" else None
        so = order_id.get(ref) if cat == "Order" else None
        if cat not in ("Purchase", "Order") or (po is None and so is None):
            check("FAIL", "Payment reference resolves", f"{r['TransactionID']}: {cat} reference {ref} not found")
            continue
        if r["PaymentStatus"] not in PAYMENT_STATUS_MAP:
            check("FAIL", "Payment status known", f"{r['TransactionID']}: {r['PaymentStatus']}")
            continue
        amount, note = money(r["Amount"]), ("Source status was 'Partial'" if r["PaymentStatus"] == "Partial" else None)
        if r["TransactionID"] in PAYMENT_AMOUNT_CORRECTIONS:
            amount, note = PAYMENT_AMOUNT_CORRECTIONS[r["TransactionID"]]
            fixes_applied.append(f"{r['TransactionID']}: amount {money(r['Amount'])} -> {amount} (approved; paid via GPay)")
        M["payment_transaction"].append(dict(
            transaction_id=uid("txn", r["TransactionID"]), transaction_code=r["TransactionID"],
            txn_date=to_date(r["TransactionDate"]), direction=DIRECTION_MAP[typ], amount=amount,
            payment_method=r["PaymentMethod"], payment_status=PAYMENT_STATUS_MAP[r["PaymentStatus"]],
            purchase_order_id=po, order_id=so, legacy_status=r["PaymentStatus"], is_migration_adjustment=False,
            note=note))
    for e in EXTRA_PAYMENTS:
        M["payment_transaction"].append(dict(
            transaction_id=uid("txn", e["code"]), transaction_code=e["code"], txn_date=e["txn_date"],
            direction="Out", amount=e["amount"], payment_method=e["method"], payment_status="Completed",
            purchase_order_id=po_id[e["po"]], order_id=None, legacy_status=None,
            is_migration_adjustment=True, note=e["note"]))
        fixes_applied.append(f"{e['code']}: added {e['amount']} payment to {e['po']} (approved; paid {e['txn_date']} via {e['method']})")

    # --- purchase order items
    po_by_code = {p["po_code"]: p for p in M["purchase_order"]}
    po_by_id = {p["purchase_order_id"]: p for p in M["purchase_order"]}
    item_of, line_no = {}, Counter()
    def add_item(po_code, sku):
        v = variants[sku]
        line_no[po_code] += 1
        it = dict(purchase_order_item_id=uid("poitem", f"{po_code}:{line_no[po_code]}"),
                  purchase_order_id=po_by_code[po_code]["purchase_order_id"], line_no=line_no[po_code],
                  variant_id=v["variant_id"], qty_ordered=v["_received"], qty_received=v["_received"],
                  unit_cost=v["unit_cost"])
        M["purchase_order_item"].append(it)
        item_of[sku] = it
    bad_sku = [k for lst in PO_KNOWN_ITEMS.values() for k in lst if k not in variants]
    if bad_sku or PO_REMAINDER not in po_by_code or any(c not in po_by_code for c in PO_KNOWN_ITEMS):
        check("FAIL", "PO item configuration valid", f"unknown SKUs {bad_sku} or PO codes")
    else:
        for po_code, skus in PO_KNOWN_ITEMS.items():
            for sku in skus:
                add_item(po_code, sku)
        remainder = [sku for sku, v in variants.items() if sku not in item_of and v["_received"] > 0]
        for sku in remainder:
            add_item(PO_REMAINDER, sku)
        fixes_applied.append(f"{', '.join(sum(PO_KNOWN_ITEMS.values(), []))}: linked to {', '.join(PO_KNOWN_ITEMS)} (stated by owner)")
        fixes_applied.append(f"{len(remainder)} other variants: linked to {PO_REMAINDER} by elimination (total ties exactly)")

    # --- inventory ledger: purchase receipts, then shipped sales (insert order matters for the no-negative trigger)
    opening_day = min(to_date(r["PurchaseDate"]) for r in src["pos"])
    opening_at = datetime.combine(opening_day, time(0, 0), tzinfo=IST)
    for v in variants.values():
        it = item_of.get(v["sku"])
        if v["_received"] > 0 and it:
            po = po_by_id[it["purchase_order_id"]]
            M["inventory_movement"].append(dict(
                movement_id=uid("move", f"recv:{v['sku']}"), variant_id=v["variant_id"],
                movement_type="Purchase Receipt", quantity=v["_received"],
                moved_at=datetime.combine(po["order_date"], time(0, 0), tzinfo=IST),
                purchase_order_item_id=it["purchase_order_item_id"], shipment_item_id=None,
                reason=f"Received on {po['po_code']} (migrated)", created_by="migration"))
        elif v["_received"] > 0:
            M["inventory_movement"].append(dict(
                movement_id=uid("move", f"open:{v['sku']}"), variant_id=v["variant_id"],
                movement_type="Opening Balance", quantity=v["_received"], moved_at=opening_at,
                shipment_item_id=None, reason="Migrated from 'Units received' in ProductMaster & Inventory",
                created_by="migration"))
        if v["_adj"] != 0:
            M["inventory_movement"].append(dict(
                movement_id=uid("move", f"adj:{v['sku']}"), variant_id=v["variant_id"],
                movement_type="Adjustment", quantity=v["_adj"], moved_at=opening_at, shipment_item_id=None,
                reason="Migrated from 'Adjustments' column", created_by="migration"))
    ord_by_id = {o["order_id"]: o for o in M["customer_order"]}
    ship_by_id = {sh["shipment_id"]: sh for sh in M["shipment"]}
    item_by_id = {it["order_item_id"]: it for it in M["order_item"]}
    for si in M["shipment_item"]:          # stock leaves per SHIPPED LINE, dated by its parcel
        it = item_by_id[si["order_item_id"]]
        o = ord_by_id[it["order_id"]]
        M["inventory_movement"].append(dict(
            movement_id=uid("move", f"sale:{si['shipment_item_id']}"), variant_id=it["variant_id"],
            movement_type="Sale Shipped", quantity=-si["quantity"],
            moved_at=datetime.combine(ship_by_id[si["shipment_id"]]["shipped_on"], time(0, 0), tzinfo=IST),
            shipment_item_id=si["shipment_item_id"], reason=f"Order {o['order_code']} shipped (migrated)",
            created_by="migration"))

    run_checks(src, M, variants, checks, po_total, cost_compare)
    return dict(M=M, src=src, checks=checks, fixes=fixes_applied, cost_compare=cost_compare,
                variants=variants, po_total=po_total, opening_day=opening_day)


# ---------------------------------------------------------------- validation / reconciliation
def po_paid_map(M):
    code_by_po = {p["purchase_order_id"]: p["po_code"] for p in M["purchase_order"]}
    paid = defaultdict(Decimal)
    for t in M["payment_transaction"]:
        if t["purchase_order_id"]:
            paid[code_by_po[t["purchase_order_id"]]] += t["amount"] * (1 if t["direction"] == "Out" else -1)
    return paid


def run_checks(src, M, variants, checks, po_total, cost_compare):
    def check(s, n, d=""): checks.append((s, n, d))

    # row counts
    pairs = [("SuppliersMaster", len(src["suppliers"]), "supplier", len(M["supplier"])),
             ("CustomersMaster", len(src["customers"]), "customer", len(M["customer"])),
             ("ProductMaster & Inventory", len(src["products"]), "product_variant", len(M["product_variant"])),
             ("PurchaseMaster", len(src["pos"]), "purchase_order", len(M["purchase_order"])),
             ("ProductMaster & Inventory (units received > 0)", sum(1 for v in variants.values() if v["_received"] > 0), "purchase_order_item", len(M["purchase_order_item"])),
             ("OrdersMaster", len(src["orders"]), "customer_order", len(M["customer_order"])),
             ("OrdersMaster", len(src["orders"]), "order_item", len(M["order_item"])),
             ("OrdersMaster (Shipped rows)", sum(1 for r in src["orders"] if r["OrderStatus"] == "Shipped"), "shipment_item", len(M["shipment_item"])),
             ("OrdersMaster (shipped orders less orders sharing a parcel)",
              sum(1 for r in src["orders"] if r["OrderStatus"] == "Shipped") - sum(len(g) - 1 for g in PARCEL_GROUPS),
              "shipment", len(M["shipment"])),
             ("Expenses & Cash", len(src["txns"]) + len(EXTRA_PAYMENTS), "payment_transaction", len(M["payment_transaction"]))]
    for s, a, t, b in pairs:
        check("PASS" if a == b else "FAIL", f"Row count {s} -> {t}", f"{a} source (incl. approved additions) vs {b} target")

    # stock: ledger balance == sheet's Available stock (Received - Sold + Adjustments)
    bal = defaultdict(int)
    for m in M["inventory_movement"]:
        bal[m["variant_id"]] += m["quantity"]
    bad = [v["sku"] for v in variants.values() if bal[v["variant_id"]] != v["_received"] - v["_sold"] + v["_adj"]]
    check("FAIL" if bad else "PASS", "Stock per variant == sheet 'Available stock'",
          f"{len(bad)} mismatches {bad[:5]}" if bad else f"all {len(variants)} variants match; total on hand {sum(bal.values())}")
    neg = [k for k, q in bal.items() if q < 0]
    check("FAIL" if neg else "PASS", "No negative stock", f"{len(neg)} variants negative")
    sold_orders = Counter()
    for it in M["order_item"]:
        sold_orders[it["_sku"]] += it["quantity"]
    mism = [s for s in set(sold_orders) | {v["sku"] for v in variants.values() if v["_sold"]}
            if sold_orders[s] != variants[s]["_sold"]]
    check("FAIL" if mism else "PASS", "Orders' quantities == sheet 'Units sold'", f"mismatches: {mism}" if mism else "match")

    # shipment lines: every order marked Shipped must be shipped in full, never more than ordered
    shipped_qty = Counter()
    for si in M["shipment_item"]:
        shipped_qty[si["order_item_id"]] += si["quantity"]
    ordered_qty = {it["order_item_id"]: it["quantity"] for it in M["order_item"]}
    ord_status = {o["order_id"]: o["status"] for o in M["customer_order"]}
    item_order = {it["order_item_id"]: it["order_id"] for it in M["order_item"]}
    bad = [k for k, q in ordered_qty.items()
           if shipped_qty[k] > q or (ord_status[item_order[k]] == "Shipped" and shipped_qty[k] != q)]
    check("FAIL" if bad else "PASS", "Shipped orders fully covered by shipment lines (never over-shipped)",
          f"{len(bad)} order lines off" if bad else f"{sum(shipped_qty.values())} units shipped across {len(M['shipment'])} parcels")

    # purchase order items tie to PO totals; every received unit sits on a PO line
    item_sum = defaultdict(Decimal)
    code_of = {p["purchase_order_id"]: p["po_code"] for p in M["purchase_order"]}
    for it in M["purchase_order_item"]:
        item_sum[code_of[it["purchase_order_id"]]] += it["qty_ordered"] * it["unit_cost"]
    off = {c: (po_total[c], t) for c, t in item_sum.items() if t != po_total[c]}
    check("FAIL" if off else "PASS", "PO line items (qty x master unit cost) == PO total",
          f"differences (PO total, items): {off}" if off else "; ".join(f"{c}: {t:,.2f}" for c, t in sorted(item_sum.items())))
    units_items = sum(i["qty_received"] for i in M["purchase_order_item"])
    units_sheet = sum(v["_received"] for v in variants.values())
    check("FAIL" if units_items != units_sheet else "PASS", "Units on PO items == sheet 'Units received'", f"{units_items} vs {units_sheet}")

    # purchases: payments vs PO total
    paid = po_paid_map(M)
    over = {c: (po_total[c], paid[c]) for c in po_total if paid[c] > po_total[c]}
    check("FAIL" if over else "PASS", "No PO overpaid", f"overpaid (total, paid): {over}" if over else f"{len(po_total)} POs, total {sum(po_total.values()):,.2f}, paid {sum(paid.values()):,.2f}")
    for c in sorted(po_total):
        if paid[c] < po_total[c]:
            check("REVIEW", f"{c} has an unpaid balance",
                  f"total {po_total[c]:,.2f}, paid {paid[c]:,.2f}, balance {po_total[c] - paid[c]:,.2f}. No payment recorded for the balance; "
                  "if it was paid, add it to EXTRA_PAYMENTS (date and method needed).")

    # orders: payments received cover product revenue
    code_by_order = {o["order_id"]: o["order_code"] for o in M["customer_order"]}
    got = defaultdict(Decimal)
    for t in M["payment_transaction"]:
        if t["order_id"]:
            got[code_by_order[t["order_id"]]] += t["amount"] * (1 if t["direction"] == "In" else -1)
    rev = {c["code"]: c["revenue"] for c in cost_compare}
    short = {c: (rev[c], got[c]) for c in rev if got[c] < rev[c]}
    check("FAIL" if short else "PASS", "Each order's receipts cover its product revenue",
          f"short: {short}" if short else f"{len(rev)} orders covered; total received {sum(got.values()):,.2f}")

    # shipping / courier
    paid_charged = sum(sh["shipping_charged"] for sh in M["shipment"])
    courier_cost = sum(sh["courier_cost"] for sh in M["shipment"])
    off_parcels = [sh["shipment_code"] for sh in M["shipment"] if sh["shipping_charged"] != sh["courier_cost"]]
    check("PASS" if not off_parcels else "REVIEW", "Shipping charged to customer == courier cost, per parcel",
          f"charged {paid_charged:,.2f} vs courier cost {courier_cost:,.2f}" + (f"; differ: {off_parcels}" if off_parcels else ""))
    check("INFO", "Courier payable (confirmed unpaid)",
          f"{courier_cost:,.2f} owed to ST Courier for {len(M['shipment'])} parcels ({len(M['shipment_item'])} order lines) "
          f"dated {SHIPPED_ON_DATE:%d %b %Y}; owner confirmed nothing has been paid yet.")
    for c in cost_compare:
        if c["sheet"] != c["master"]:
            check("INFO", f"{c['code']} order cost taken from product master",
                  f"{c['sku']}: sheet order UnitCost {c['sheet']} ignored; master unit cost {c['master']} used (approved rule)")

    # the 550 gap: stock at master cost vs stock-affecting purchase orders
    garment_pos = {p["po_code"]: p["total_amount"] for p in M["purchase_order"] if p["purchase_type"] in PURCHASE_TYPES_AFFECTING_STOCK}
    stock_value = sum(v["unit_cost"] * v["_received"] for v in variants.values())
    gap = stock_value - sum(garment_pos.values())
    if gap == 0:
        check("PASS", "Stock at master unit cost == stock-affecting PO totals", f"{stock_value:,.2f}")
    else:
        single_po = [(c, t) for c, t in garment_pos.items()
                     if any(v["unit_cost"] * v["_received"] == t for v in variants.values() if v["_received"] == 1)]
        cands = sorted(v["sku"] for v in variants.values() if v["unit_cost"] == abs(gap) and v["_received"] == 1)
        detail = (f"Stock at master cost {stock_value:,.2f} vs garment POs {sum(garment_pos.values()):,.2f}: gap {gap:,.2f}. "
                  + "".join(f"{c} ({t:,.2f}) equals one variant's cost exactly. " for c, t in single_po)
                  + f"Only a single unit costing {abs(gap):,.2f} fits the gap ({len(cands)} candidate variants), "
                  "so either one such unit is not covered by a PO, or a discount applied. Cannot tell which: OPEN GAP.")
        check("OPEN", "Stock vs purchase orders gap", detail)


# ---------------------------------------------------------------- outputs
def write_outputs(model, out):
    out = Path(out)
    (out / "csv").mkdir(parents=True, exist_ok=True)
    M = model["M"]
    for t, cols in TABLE_COLUMNS.items():
        with open(out / "csv" / f"{t}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols)
            for r in M[t]:
                w.writerow(["" if r.get(c) is None else r.get(c) for c in cols])
    lines = ["# Nadhi's Couture - Migration reconciliation report", "",
             f"Generated {datetime.now(IST):%Y-%m-%d %H:%M} IST. Mode: dry run unless noted. Source workbook is never modified.", ""]
    fails = [c for c in model["checks"] if c[0] == "FAIL"]
    lines += ["(PASS = verified. INFO = handled by an approved rule. REVIEW = assumption to confirm. OPEN = known unexplained gap. Only FAIL blocks a load.)", ""]
    lines += [f"**Result: {'BLOCKED - ' + str(len(fails)) + ' failed check(s)' if fails else 'READY TO LOAD'}**", "",
              "## Target row counts", "", "| Table | Rows |", "|---|---|"]
    lines += [f"| {t} | {len(M[t])} |" for t in LOAD_ORDER]
    lines += ["", "## Corrections applied", ""] + [f"- {x}" for x in model["fixes"]]
    lines += ["", "## Checks", "", "| Status | Check | Detail |", "|---|---|---|"]
    lines += [f"| {s} | {n} | {d} |" for s, n, d in model["checks"]]
    lines += ["", "## Orders: profit (selling price - master unit cost) and shipping", "",
              "| Order | SKU | Qty | Revenue | Unit cost (master) | Profit | Shipping collected | Courier cost | Shipping margin |",
              "|---|---|---|---|---|---|---|---|---|"]
    for c in model["cost_compare"]:
        profit = c["revenue"] - c["qty"] * c["used"]
        lines.append(f"| {c['code']} | {c['sku']} | {c['qty']} | {c['revenue']} | {c['used']} | {profit} | {c['charged']} | {c['ship_cost']} | {c['charged'] - c['ship_cost']} |")
    lines += ["", f"Opening stock is dated {model['opening_day']} (earliest purchase date). Shipments dated {SHIPPED_ON_DATE}. All timestamps are Asia/Kolkata."]
    (out / "reconciliation_report.md").write_text("\n".join(lines), encoding="utf-8")
    return out / "reconciliation_report.md"


def load(model, dsn):
    import psycopg
    M = model["M"]
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT (SELECT count(*) FROM supplier) + (SELECT count(*) FROM product_variant) + (SELECT count(*) FROM customer_order)")
            if cur.fetchone()[0] != 0:
                sys.exit("Refusing to load: target database already has data. Load into an empty schema.")
            for t in LOAD_ORDER:
                cols = TABLE_COLUMNS[t]
                if not M[t]:
                    continue
                sql = f"INSERT INTO {t} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})"
                cur.executemany(sql, [[r.get(c) for c in cols] for r in M[t]])
                print(f"  loaded {len(M[t]):>3} -> {t}")
            if M["shipment"]:
                cur.execute("SELECT setval('shipment_code_seq', %s)", (len(M["shipment"]),))
            # post-load verification straight from the database
            problems = []
            cur.execute("SELECT sku, on_hand FROM inventory_balance")
            db_bal = dict(cur.fetchall())
            for sku, v in model["variants"].items():
                exp = v["_received"] - v["_sold"] + v["_adj"]
                if db_bal.get(sku) != exp:
                    problems.append(f"stock {sku}: db {db_bal.get(sku)} vs sheet {exp}")
            exp_paid = po_paid_map(M)
            cur.execute("SELECT po_code, total_amount, paid FROM purchase_order_summary")
            for code, total, paid in cur.fetchall():
                if paid != exp_paid[code]:
                    problems.append(f"{code}: paid db {paid} vs expected {exp_paid[code]} (total {total})")
            cur.execute("""SELECT po.po_code, po.total_amount, SUM(i.qty_ordered * i.unit_cost)
                           FROM purchase_order po JOIN purchase_order_item i USING (purchase_order_id) GROUP BY 1, 2""")
            for code, total, items in cur.fetchall():
                if total != items:
                    problems.append(f"{code}: PO total {total} vs items {items}")
            cur.execute("SELECT order_code FROM order_summary WHERE status = 'Shipped' AND ordered_qty <> shipped_qty")
            for (code,) in cur.fetchall():
                problems.append(f"{code}: marked Shipped but shipped quantity differs from ordered")
            cur.execute("SELECT order_code, payment_state FROM order_summary")
            for code, st in cur.fetchall():
                if st != "Paid":
                    problems.append(f"{code}: state {st}")
            cur.execute("SELECT COALESCE(SUM(shipping_charged), 0), COALESCE(SUM(courier_cost), 0) FROM shipment")
            ch, co = cur.fetchone()
            exp_ch = sum(sh["shipping_charged"] for sh in M["shipment"])
            if ch != exp_ch:
                problems.append(f"shipping charged: db {ch} vs expected {exp_ch}")
            cur.execute("SELECT COALESCE(SUM(amount_due), 0) FROM courier_payable")
            due = cur.fetchone()[0]
            exp_due = sum(sh["courier_cost"] for sh in M["shipment"])
            if due != exp_due:
                problems.append(f"courier payable: db {due} vs expected {exp_due}")
            cur.execute("SELECT order_code, profit FROM order_summary")
            exp_profit = {c["code"]: c["revenue"] - c["qty"] * c["used"] for c in model["cost_compare"]}
            for code, profit in cur.fetchall():
                if profit != exp_profit.get(code):
                    problems.append(f"{code}: profit db {profit} vs expected {exp_profit.get(code)}")
            if problems:
                raise SystemExit("Post-load verification FAILED, rolling back:\n  " + "\n  ".join(problems))
            print("  post-load verification passed (stock, PO payments, PO items, order payments, courier payable, profit)")
    print("Committed.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--out", default="reports")
    ap.add_argument("--load", action="store_true", help="actually write to the database (default is dry run)")
    ap.add_argument("--dsn", help="PostgreSQL connection string (required with --load)")
    a = ap.parse_args()
    model = build_model(a.xlsx)
    rpt = write_outputs(model, a.out)
    fails = [c for c in model["checks"] if c[0] == "FAIL"]
    for s, n, d in model["checks"]:
        print(f"[{s:6}] {n}" + (f" - {d}" if d else ""))
    print(f"\nReport: {rpt}\nCSV:    {Path(a.out) / 'csv'}")
    if fails:
        sys.exit(f"\n{len(fails)} failed check(s). Nothing loaded.")
    if a.load:
        if not a.dsn:
            sys.exit("--load needs --dsn")
        load(model, a.dsn)
    else:
        print("\nDRY RUN complete. Nothing was written to any database.")


if __name__ == "__main__":
    main()
