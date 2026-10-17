import { useEffect, useMemo, useRef, useState } from 'react';
import { formatInrText } from '../money.js';

// Grouped columns by month, two series, plain SVG. Follows the dataviz rules: one axis, thin marks (24px at most) with a
// 4px rounded data end, 2px gap between neighbours, hairline grid, a legend (two series), a hover/keyboard tooltip, and the
// same numbers in the table that always sits under the chart. Plotted values are only for drawing; the text shows exact strings.
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthShort = (ym) => `${SHORT[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
export const monthLong = (ym) => `${SHORT[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

const W = 640;
const H = 260;
const M = { l: 56, r: 12, t: 12, b: 32 };

const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const tick = (v) => (v === 0 ? '0' : `${v < 0 ? '-' : ''}₹${compact.format(Math.abs(v))}`);

function niceTicks(min, max) {
  const lo0 = Math.min(0, min);
  const hi0 = Math.max(0, max);
  const raw = (hi0 - lo0) / 4 || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(lo0 / step) * step;
  let hi = Math.ceil(hi0 / step) * step;
  if (hi === lo) hi = lo + step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(Math.round(v * 100) / 100);
  return { lo, hi, ticks };
}

// a column with a 4px rounded data end, square at the baseline
function barPath(x, w, base, top, r = 4) {
  const h = Math.abs(base - top);
  if (h < 0.5) return '';
  const rr = Math.min(r, h, w / 2);
  if (top < base) return `M${x},${base}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + w - rr}Q${x + w},${top} ${x + w},${top + rr}V${base}Z`;
  return `M${x},${base}V${top - rr}Q${x},${top} ${x + rr},${top}H${x + w - rr}Q${x + w},${top} ${x + w},${top - rr}V${base}Z`;
}

// months: ['2026-09', ...]; each series: { name, color, values: ['123.45', ...] }
export default function MonthlyBarChart({ title, months, a, b }) {
  const [hover, setHover] = useState(null);
  const scroller = useRef(null);
  // on a narrow screen the chart scrolls sideways: open it on the newest months
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [months.length, a.values, b.values]);
  const nums = useMemo(() => ({ a: a.values.map(Number), b: b.values.map(Number) }), [a.values, b.values]);
  const all = [...nums.a, ...nums.b];
  const empty = months.length === 0 || all.every((v) => v === 0);

  const geo = useMemo(() => {
    const { lo, hi, ticks } = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const plotW = W - M.l - M.r;
    const plotH = H - M.t - M.b;
    const y = (v) => M.t + plotH * (1 - (v - lo) / (hi - lo));
    const band = plotW / Math.max(months.length, 1);
    const barW = Math.max(2, Math.min(24, (band - 8) / 2));
    return { ticks, y, band, barW, plotH, base: y(0), every: Math.ceil(months.length / 8) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months.length, nums]);

  const label = (i) => `${monthLong(months[i])}: ${a.name} ${formatInrText(a.values[i])}, ${b.name} ${formatInrText(b.values[i])}`;
  const center = hover === null ? 0 : M.l + geo.band * hover + geo.band / 2;

  return (
    <div className="chart">
      <div className="legend" aria-label="Legend">
        {[a, b].map((s) => (
          <span key={s.name}><i className="swatch" style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
      {empty ? (
        <p className="muted chart-empty">Nothing to show for this period.</p>
      ) : (
        <div className="chart-scroll" ref={scroller}>
        <div className="chart-wrap" onPointerLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, ${months.length} months. The table below has every number.`}>
            {geo.ticks.map((v) => (
              <g key={v}>
                <line x1={M.l} x2={W - M.r} y1={geo.y(v)} y2={geo.y(v)} className="grid" />
                <text x={M.l - 8} y={geo.y(v) + 4} textAnchor="end" className="axis-text">{tick(v)}</text>
              </g>
            ))}
            <line x1={M.l} x2={W - M.r} y1={geo.base} y2={geo.base} className="baseline" />
            {hover !== null && <rect x={M.l + geo.band * hover} y={M.t} width={geo.band} height={geo.plotH} className="hover-band" />}
            {months.map((m, i) => {
              const gx = M.l + geo.band * i + (geo.band - (geo.barW * 2 + 2)) / 2;
              return (
                <g key={m}>
                  <path d={barPath(gx, geo.barW, geo.base, geo.y(nums.a[i]))} fill={a.color} />
                  <path d={barPath(gx + geo.barW + 2, geo.barW, geo.base, geo.y(nums.b[i]))} fill={b.color} />
                  {/* label counting back from the latest month, so the latest month always has its label */}
                  {(months.length - 1 - i) % geo.every === 0 && (
                    <text x={M.l + geo.band * i + geo.band / 2} y={H - 10} textAnchor="middle" className="axis-text">{monthShort(m)}</text>
                  )}
                  {/* the hover and keyboard target is the whole month, much bigger than the bars */}
                  <rect
                    x={M.l + geo.band * i} y={M.t} width={geo.band} height={geo.plotH} fill="transparent" tabIndex={0} role="group" aria-label={label(i)}
                    onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div className="chart-tip" style={{ left: `${Math.min(Math.max((center / W) * 100, 18), 82)}%` }} role="status">
              <div className="chart-tip-month">{monthLong(months[hover])}</div>
              {[a, b].map((s) => (
                <div key={s.name} className="chart-tip-row">
                  <i className="swatch-line" style={{ background: s.color }} />
                  <strong>{formatInrText(s.values[hover])}</strong>
                  <span>{s.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
      )}
      {!empty && <p className="muted chart-hint">Swipe sideways to see every month.</p>}
    </div>
  );
}
