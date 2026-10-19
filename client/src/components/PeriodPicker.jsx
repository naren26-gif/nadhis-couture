import { PRESETS, todayMonth } from '../periods.js';
import { monthLong } from './MonthlyBarChart.jsx';

// The "Period" box used on Home and Reports. The parent keeps preset/custom in state.
export default function PeriodPicker({ preset, setPreset, custom, setCustom, period }) {
  const periodText = !period.from && !period.to ? 'all time' : `${period.from ? monthLong(period.from) : 'the start'} to ${period.to ? monthLong(period.to) : 'now'}`;
  return (
    <div className="card period-bar">
      <div className="field">
        <label htmlFor="period">Period</label>
        <select id="period" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {PRESETS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      {preset === 'custom' && (
        <>
          <div className="field">
            <label htmlFor="from">From month</label>
            <input id="from" type="month" value={custom.from} max={todayMonth()} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="to">To month</label>
            <input id="to" type="month" value={custom.to} max={todayMonth()} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </div>
        </>
      )}
      <p className="muted period-note">Showing {periodText}. Stock and money owed are always as of today.</p>
    </div>
  );
}
