import { monthLong } from './MonthlyBarChart.jsx';
import { formatInrText } from '../money.js';

// A tiny line of one value per month, for the dashboard. Only for the shape: the exact numbers are in the text above it.
// months: ['2026-09', ...]; values: ['123.45', ...] (strings from the server, used only to draw).
export default function Sparkline({ months, values, color, label }) {
  const nums = values.map(Number);
  if (nums.length < 2 || nums.every((v) => v === 0)) return null;
  const W = 200;
  const H = 44;
  const pad = 4;
  const lo = Math.min(0, ...nums);
  const hi = Math.max(0, ...nums);
  const x = (i) => pad + ((W - pad * 2) * i) / (nums.length - 1);
  const y = (v) => pad + (H - pad * 2) * (1 - (v - lo) / (hi - lo || 1));
  const points = nums.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = nums.length - 1;
  const summary = `${label} by month, ${monthLong(months[0])} to ${monthLong(months[last])}: latest ${formatInrText(values[last])}`;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary}>
      <line x1={pad} x2={W - pad} y1={y(0)} y2={y(0)} className="baseline" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(last)} cy={y(nums[last])} r="3.5" fill={color} />
    </svg>
  );
}
