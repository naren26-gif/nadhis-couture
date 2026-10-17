import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import '../src/config.js';
import { createApp } from '../src/app.js';
import { requireLogin, sessionMiddleware } from '../src/auth/index.js';
import { hashPassword, checkPassword } from '../src/auth/passwords.js';
import { closePool } from '../src/db.js';
import { describeError } from '../src/errors.js';

const config = { isProduction: false, sessionSecret: 'test-secret-test-secret-test-secret-123' };
const app = createApp(config);

// A tiny app with one guarded route, to prove requireLogin blocks anonymous visitors.
const guarded = express();
guarded.use(sessionMiddleware(config));
guarded.get('/protected', requireLogin, (req, res) => res.json({ ok: true }));
guarded.use((err, req, res, next) => {
  const { status, message } = describeError(err);
  res.status(status).json({ error: message });
});

afterAll(closePool);

describe('login', () => {
  it('rejects an unknown email or wrong password with the same friendly message', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Wrong email or password.');
  });

  it('asks for missing fields in plain English', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Please enter your password.');
  });

  it('says nobody is logged in when there is no session', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.body).toEqual({ user: null });
  });

  it('blocks protected routes for anonymous visitors', async () => {
    const res = await request(guarded).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Please log in to continue.');
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('a-long-test-password');
    expect(hash).not.toContain('a-long-test-password');
    expect(await checkPassword('a-long-test-password', hash)).toBe(true);
    expect(await checkPassword('different', hash)).toBe(false);
  });
});
