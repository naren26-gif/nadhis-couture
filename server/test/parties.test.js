import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/db.js';
import { startTestApp } from './helpers.js';

let t;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.stop();
  await closePool();
});

const KINDS = [
  { path: '/api/suppliers', prefix: 'SPLR', width: 4, extra: { contact_person: 'Zz Contact' } },
  { path: '/api/customers', prefix: 'CUST', width: 6, extra: {} },
];

const number = (code) => Number(code.replace(/^\D+/, ''));

describe.each(KINDS)('$path', ({ path, prefix, width, extra }) => {
  const make = (overrides = {}) =>
    request(t.app).post(path).send({ name: 'Zz Test Person', phone: '+91 90000 11111', ...extra, ...overrides });

  it('gives the highest existing code + 1 in the shop\'s width, with no gaps even after a failed save', async () => {
    const before = await request(t.app).get(path).query({ inactive: 'true' });
    const standard = new RegExp(`^${prefix}\\d{${width}}$`);
    const highest = Math.max(0, ...before.body.items.filter((i) => standard.test(i.code)).map((i) => number(i.code)));
    const code = (n) => prefix + String(n).padStart(width, '0');

    const first = await make({ phone: '+91 90000 22221' });
    expect(first.status).toBe(201);
    expect(first.body.item.code).toBe(code(highest + 1));

    // a refused save (duplicate phone) must not use up a number
    const refused = await make({ phone: '+91 90000 22221' });
    expect(refused.status).toBe(409);

    const second = await make({ phone: '+91 90000 22222' });
    expect(second.body.item.code).toBe(code(highest + 2));
  });

  it('keeps the phone as text and the code unchanged when editing', async () => {
    const created = await make({ phone: '0044 123 456' });
    const { id, code } = created.body.item;
    expect(created.body.item.phone).toBe('0044 123 456');

    const edited = await request(t.app)
      .patch(`${path}/${id}`)
      .send({ name: 'Zz Renamed', phone: '0044 123 456', email: 'zz@example.com', location: 'Chennai', ...extra });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({ name: 'Zz Renamed', code, email: 'zz@example.com', location: 'Chennai' });
  });

  it('turns empty optional fields into nothing', async () => {
    const res = await make({ phone: '', email: '', location: '' });
    expect(res.status).toBe(201);
    expect(res.body.item.phone).toBeNull();
    expect(res.body.item.email).toBeNull();
  });

  it('explains bad input in plain English', async () => {
    const noName = await make({ name: '   ' });
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/name/i);

    const badPhone = await make({ phone: 'call me' });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error).toMatch(/phone number/i);

    const badEmail = await make({ phone: '', email: 'not-an-email' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error).toMatch(/email/i);
  });

  it('refuses a duplicate phone and says who has it', async () => {
    const owner = await make({ name: 'Zz Phone Owner', phone: '+91 90000 33333' });
    expect(owner.status).toBe(201);
    const dup = await make({ name: 'Zz Someone Else', phone: '+91 90000 33333' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe(`That phone number already belongs to Zz Phone Owner (${owner.body.item.code}).`);

    // editing a person without changing their own phone is fine
    const same = await request(t.app)
      .patch(`${path}/${owner.body.item.id}`)
      .send({ name: 'Zz Phone Owner', phone: '+91 90000 33333', ...extra });
    expect(same.status).toBe(200);
  });

  it('searches by name, code and phone, and hides hidden ones unless asked', async () => {
    const created = await make({ name: 'Zz Findable Name', phone: '+91 90000 44444' });
    const { id, code } = created.body.item;
    for (const search of ['findable', code, '90000 44444']) {
      const res = await request(t.app).get(path).query({ search });
      expect(res.body.items.map((i) => i.id)).toContain(id);
    }

    const hide = await request(t.app).post(`${path}/${id}/deactivate`);
    expect(hide.status).toBe(200);
    expect(hide.body.item.is_active).toBe(false);
    const visible = await request(t.app).get(path).query({ search: 'findable' });
    expect(visible.body.items).toEqual([]);
    const all = await request(t.app).get(path).query({ search: 'findable', inactive: 'true' });
    expect(all.body.items).toHaveLength(1);

    const show = await request(t.app).post(`${path}/${id}/activate`);
    expect(show.body.item.is_active).toBe(true);
  });

  it('lets only the owner hide, and answers 404 for unknown ids', async () => {
    const created = await make({ phone: '+91 90000 55555' });
    const staff = await request(t.app).post(`${path}/${created.body.item.id}/deactivate`).set('x-test-role', 'staff');
    expect(staff.status).toBe(403);
    expect(staff.body.error).toBe('Only the owner can do that.');

    const missing = await request(t.app).get(`${path}/11111111-1111-4111-8111-111111111111`);
    expect(missing.status).toBe(404);
  });
});
