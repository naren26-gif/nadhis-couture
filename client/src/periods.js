// Period choices shared by the Home dashboard and the Reports screen. Months are 'YYYY-MM' in Indian time.
export const todayMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);

export const addMonths = (ym, n) => {
  const index = Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

export const PRESETS = [
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['last_3', 'Last 3 months'],
  ['last_6', 'Last 6 months'],
  ['this_year', 'This year so far'],
  ['all', 'All time'],
  ['custom', 'Choose months...'],
];

export const defaultCustom = () => ({ from: addMonths(todayMonth(), -5), to: todayMonth() });

export function periodOf(preset, custom) {
  const now = todayMonth();
  switch (preset) {
    case 'this_month': return { from: now, to: now };
    case 'last_month': return { from: addMonths(now, -1), to: addMonths(now, -1) };
    case 'last_3': return { from: addMonths(now, -2), to: now };
    case 'last_6': return { from: addMonths(now, -5), to: now };
    case 'this_year': return { from: `${now.slice(0, 4)}-01`, to: now };
    case 'custom': return { from: custom.from, to: custom.to };
    default: return { from: '', to: '' };
  }
}

export function periodQuery(period) {
  const q = new URLSearchParams();
  if (period.from) q.set('from', period.from);
  if (period.to) q.set('to', period.to);
  return q;
}
