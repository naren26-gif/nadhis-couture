const PAYMENT = { Unpaid: 'bad', Partial: 'warn', Paid: 'good', Overpaid: 'warn' };
const RECEIPT = { 'Not received': 'bad', 'Partly received': 'warn', Received: 'good', 'No stock': 'muted-badge' };

export function PaymentBadge({ state }) {
  return <span className={`badge ${PAYMENT[state] || 'muted-badge'}`}>{state}</span>;
}

export function ReceiptBadge({ state }) {
  return <span className={`badge ${RECEIPT[state] || 'muted-badge'}`}>{state}</span>;
}
