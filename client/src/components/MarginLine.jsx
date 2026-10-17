import { formatInr, marginOf } from '../money.js';

// Live "margin = list price - unit cost" under the price fields.
export default function MarginLine({ listPrice, unitCost }) {
  const margin = marginOf(listPrice, unitCost);
  if (!margin) return <div className="margin-line muted">Margin will show here once both prices are filled in.</div>;
  const negative = margin.paise < 0;
  const percent = margin.percent === null ? '' : ` (${margin.percent.toFixed(1)}% of the list price)`;
  return (
    <div className={`margin-line ${negative ? 'bad' : 'good'}`} aria-live="polite">
      Margin: <strong>{formatInr(margin.paise)}</strong>{percent}
      {negative && <div>The list price is lower than the unit cost, so you would lose money on each sale.</div>}
    </div>
  );
}
