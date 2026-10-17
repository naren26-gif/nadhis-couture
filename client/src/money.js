// Money on screen is handled as whole paise (integers), never as decimal floats, so 0.1 + 0.2 style errors cannot happen.
// "450.50" -> 45050. Returns null if the text is not a valid amount (0 or more, at most 2 decimals).
export function toPaise(text) {
  const clean = String(text ?? '').trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return null;
  const [rupees, fraction = ''] = clean.split('.');
  return Number(rupees) * 100 + Number((fraction + '00').slice(0, 2));
}

// 45050 -> "₹450.50", with Indian digit grouping: 1234567 paise -> "₹12,345.67"
export function formatInr(paise) {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100).toLocaleString('en-IN');
  const fraction = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}₹${rupees}.${fraction}`;
}

// Same for amounts that arrive from the server as strings like "450.00"
export function formatInrText(text) {
  const paise = toPaise(text);
  if (paise !== null) return formatInr(paise);
  const negative = String(text).trim().startsWith('-');
  const positive = toPaise(String(text).replace('-', ''));
  return positive === null ? String(text) : formatInr(negative ? -positive : positive);
}

// margin = list price - unit cost; null if either is not a valid amount yet
export function marginOf(listText, costText) {
  const list = toPaise(listText);
  const cost = toPaise(costText);
  if (list === null || cost === null) return null;
  return { paise: list - cost, percent: list === 0 ? null : ((list - cost) / list) * 100 };
}
