// Business codes (SPLR0001, CUST000001, PO_0000001, TRAN_00000001 ...): the next code is simply the HIGHEST existing
// code + 1, in the same width the shop already uses. Unlike a database counter this never skips a number after a failed
// save, and it follows whatever is really in the table.
//
// Call it INSIDE a transaction (see inTransaction in db.js), then insert straight away. The lock below is held until
// that transaction ends, so two people saving at the same moment cannot receive the same number.
// `table`, `column`, `prefix` and `width` are fixed constants in our own code, never user input.
export async function nextCode(db, { table, column, prefix, width }) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`code:${table}`]);
  // Only codes in the exact standard shape count (e.g. TRAN_MIG_0001 or an odd-width code is ignored).
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(substring(${column} from '[0-9]+$')::bigint), 0) + 1 AS n FROM ${table} WHERE ${column} ~ $1`,
    [`^${prefix}[0-9]{${width}}$`],
  );
  const digits = String(rows[0].n);
  if (digits.length > width) throw new Error(`Ran out of ${prefix} codes (${width} digits)`);
  return prefix + digits.padStart(width, '0');
}
