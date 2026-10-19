import { Link } from 'react-router-dom';
import { formatInrText } from '../money.js';

// Horizontal bars on ONE shared scale, so amounts can be compared by eye. The exact amount is always printed as text.
// rows: [{ label, value: '123.45', color, to?, note? }]. Values are strings from the server, used only to size the bars.
export default function CompareBars({ rows }) {
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.value))), 0);
  return (
    <ul className="bars">
      {rows.map((r) => {
        const pct = max === 0 ? 0 : (Math.abs(Number(r.value)) / max) * 100;
        const body = (
          <>
            <span className="bar-label">{r.label}{r.note && <span className="muted"> {r.note}</span>}</span>
            <strong className="bar-value">{formatInrText(r.value)}</strong>
            <span className="bar-track"><span className="bar-fill" style={{ width: `${pct}%`, background: r.color }} /></span>
          </>
        );
        return (
          <li key={r.label}>
            {r.to ? <Link to={r.to} className="bar-row card-link">{body}</Link> : <div className="bar-row">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}
