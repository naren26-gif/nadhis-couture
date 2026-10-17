import { describe, expect, it, vi } from 'vitest';
import { UserError, describeError, isConnectionProblem } from '../src/errors.js';

describe('describeError', () => {
  it('passes our own plain-English messages through', () => {
    expect(describeError(new UserError('Not enough stock: only 1 left', 400))).toEqual({ status: 400, message: 'Not enough stock: only 1 left' });
  });

  it('explains connection problems and says nothing was saved', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const err of [
      Object.assign(new Error('password authentication failed for user "app_backend"'), { code: '28P01' }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      new Error('Connection terminated unexpectedly'),
      new Error('timeout exceeded when trying to connect'),
    ]) {
      expect(isConnectionProblem(err)).toBe(true);
      const { status, message } = describeError(err);
      expect(status).toBe(503);
      expect(message).toBe('Could not reach the database just now. Nothing was saved. Please try again in a moment.');
      expect(message).not.toMatch(/password|app_backend|ECONN/i); // raw database text never reaches the screen
    }
  });

  it('explains clashes, big numbers and badly formatted values', () => {
    expect(describeError(Object.assign(new Error('deadlock detected'), { code: '40P01' })).message).toMatch(/Someone else was changing/);
    expect(describeError(Object.assign(new Error('x'), { code: '22003' })).message).toMatch(/too large/);
    expect(describeError(Object.assign(new Error('invalid input syntax for type date: "abc"'), { code: '22P02' })).message).toMatch(/not in the right format/);
  });

  it('gives an unknown error a short reference, logs the real reason with it, and hides the raw text', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, message } = describeError(new Error('relation "secret_table" does not exist'));
    expect(status).toBe(500);
    const ref = message.match(/reference ([0-9A-F]{6})/)?.[1];
    expect(ref).toBeTruthy();
    expect(message).not.toMatch(/secret_table/);
    expect(log.mock.calls.at(-1).join(' ')).toContain(`ref ${ref}`);
    expect(log.mock.calls.at(-1).join(' ')).toContain('secret_table');
  });

  it('does not treat an ordinary error as a connection problem', () => {
    expect(isConnectionProblem(new Error('something else'))).toBe(false);
    expect(isConnectionProblem(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
  });
});
