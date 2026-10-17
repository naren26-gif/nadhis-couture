// Test app for the screens' API: a fake logged-in user plus ONE database transaction that is rolled back at the end,
// so tests never leave rows in the dev database (the app role cannot DELETE them).
import express from 'express';
import '../src/config.js';
import { getPool } from '../src/db.js';
import { protectedRouter } from '../src/routes/index.js';
import { describeError } from '../src/errors.js';

export async function startTestApp() {
  const client = await getPool().connect();
  await client.query('BEGIN');

  const app = express();
  app.use(express.json());
  app.use(async (req, res, next) => {
    try {
      req.db = client;
      const role = req.get('x-test-role') || 'owner';
      req.user = { id: '00000000-0000-0000-0000-000000000000', email: 'test@example.com', name: 'Test', role };
      await client.query('SAVEPOINT request_start');
      next();
    } catch (err) {
      next(err);
    }
  });
  app.use('/api', protectedRouter);
  app.use(async (err, req, res, next) => {
    // a failed request must not poison the transaction: undo just that request, then answer
    await client.query('ROLLBACK TO SAVEPOINT request_start').catch(() => {});
    const { status, message } = describeError(err);
    res.status(status).json({ error: message });
  });

  return {
    app,
    async stop() {
      await client.query('ROLLBACK');
      client.release();
    },
  };
}
