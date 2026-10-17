import { Router } from 'express';
import { query } from '../db.js';

export const healthRouter = Router();

// Open to everyone (no login): says whether the server and the database are alive. Reveals nothing else.
healthRouter.get('/', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});
