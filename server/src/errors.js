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

  switch (err?.code) {
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

  console.error('Unexpected error:', err?.code || '', err?.message);
  return { status: 500, message: 'Something went wrong on our side. Please try again.' };
}
