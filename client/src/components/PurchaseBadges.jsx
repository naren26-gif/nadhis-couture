const PAYMENT = { Unpaid: 'bad', Partial: 'warn', Paid: 'good', Advance: 'good', Overpaid: 'warn' };
const ORDER_STATUS = { Pending: 'warn', 'Partially Shipped': 'warn', Shipped: 'good', Delivered: 'good' };
const RECEIPT = { 'Not received': 'bad', 'Partly received': 'warn', Received: 'good', 'No stock': 'muted-badge' };

export function PaymentBadge({ state }) {
  return <span className={`badge ${PAYMENT[state] || 'muted-badge'}`}>{state}</span>;
}

const SHIPMENT_STATUS = { Shipped: 'warn', 'In Transit': 'warn', Delivered: 'good' };

export function ShipmentStatusBadge({ status }) {
  return <span className={`badge ${SHIPMENT_STATUS[status] || 'muted-badge'}`}>{status}</span>;
}

export function OrderStatusBadge({ status }) {
  return <span className={`badge ${ORDER_STATUS[status] || 'muted-badge'}`}>{status}</span>;
}

export function ReceiptBadge({ state }) {
  return <span className={`badge ${RECEIPT[state] || 'muted-badge'}`}>{state}</span>;
}
