import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import '../src/config.js';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db.js';

const app = createApp({
  isProduction: false,
  sessionSecret: 'test-secret-test-secret-test-secret-123',
});

afterAll(closePool);

describe('health check', () => {
  it('reports the server and database are up', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: true });
  });
});
