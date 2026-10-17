import { randomBytes } from 'node:crypto';

// Errors we raise on purpose carry a plain-English message that is safe to show to users.
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Turn anything that went wrong into { status, message }. Raw database text never reaches the browser.
export function describeError(err) {
  if (err instanceof UserError) return { status: err.status, message: err.message };

  if (err?.name === 'ZodError') {
    const first = err.issues[0];
    return { status: 400, message: first?.message || 'Please check the form and try again.' };
  }

  if (isConnectionProblem(err)) {
    console.error('Database connection problem:', err?.code || '', err?.message);
    return { status: 503, message: 'Could not reach the database just now. Nothing was saved. Please try again in a moment.' };
  }

  switch (err?.code) {
    case '40001':
    case '40P01':
    case '55P03':
      return { status: 409, message: 'Someone else was changing the same thing at that moment. Nothing was saved. Please try again.' };
    case '22003':
      return { status: 400, message: 'One of the numbers is too large. Please check the amounts and quantities.' };
    case '22P02':
    case '22007':
    case '22008':
      return { status: 400, message: 'One of the values is not in the right format (for example a date or a number). Please check the form.' };
    case '23505':
      return { status: 409, message: 'That already exists. Please use a different value.' };
    case '23514':
      return { status: 400, message: 'One of the values is not allowed. Please check the form.' };
    case '23503':
      return { status: 400, message: 'That item is linked to other records and cannot be changed this way.' };
    case '23502':
      return { status: 400, message: 'A required field is missing.' };
    case '57014':
      return { status: 503, message: 'That took too long. Please try again.' };
  }

  // Still unknown: show a short reference. The same reference is printed in the server terminal next to the real
  // reason, so a person can quote it and we can find the exact cause. The raw database text is never shown to users.
  const ref = randomBytes(3).toString('hex').toUpperCase();
  console.error(`Unexpected error [ref ${ref}]:`, err?.code || '', err?.message);
  return { status: 500, message: `Something went wrong on our side (reference ${ref}). Please try again, and tell us the reference if it keeps happening.` };
}

// Trouble reaching or staying connected to PostgreSQL (wrong/rejected login at the pooler, dropped or refused
// connection, server restarting, too many connections, timeouts). Safe to try again.
const CONNECTION_CODES = new Set([
  '28P01', '28000', // login rejected
  '08000', '08001', '08003', '08004', '08006', '08007', // connection exceptions
  '57P01', '57P02', '57P03', // server shutting down / starting
  '53300', // too many connections
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE',
]);
export function isConnectionProblem(err) {
  if (CONNECTION_CODES.has(err?.code)) return true;
  return /connection terminated|timeout exceeded when trying to connect|password authentication failed|Client has encountered a connection error/i.test(
    err?.message || '',
  );
}
