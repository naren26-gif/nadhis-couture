import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/db.js';
import { ADDRESS, startTestApp } from './helpers.js';

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
  { path: '/api/customers', prefix: 'CUST', width: 6, extra: ADDRESS },
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
    const created = await make({ phone: '098765 00001' });
    const { id, code } = created.body.item;
    expect(created.body.item.phone).toBe('098765 00001');

    const edited = await request(t.app)
      .patch(`${path}/${id}`)
      .send({ name: 'Zz Renamed', phone: '098765 00001', email: 'zz@example.com', location: 'Chennai', ...extra });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({ name: 'Zz Renamed', code, email: 'zz@example.com', location: 'Chennai' });
  });

  it('turns empty optional fields into nothing', async () => {
    // a customer must have a phone (see below); a supplier may leave it empty
    const res = await make({ phone: path.includes('customers') ? '+91 90000 66666' : '', email: '', location: '' });
    expect(res.status).toBe(201);
    if (!path.includes('customers')) expect(res.body.item.phone).toBeNull();
    expect(res.body.item.email).toBeNull();
  });

  it('explains bad input in plain English', async () => {
    const noName = await make({ name: '   ' });
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/name/i);

    const badPhone = await make({ phone: 'call me' });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error).toMatch(/phone number/i);

    const badEmail = await make({ phone: '+91 90000 77777', email: 'not-an-email' });
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

describe('customers need a phone and one delivery address', () => {
  const path = '/api/customers';
  const make = (overrides = {}) =>
    request(t.app).post(path).send({ name: 'Zz Address Person', phone: '+91 90000 81111', ...ADDRESS, ...overrides });

  it('saves and returns the address', async () => {
    const res = await make({ address_line2: 'Flat 2', phone: '+91 90000 81112' });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ address_line1: '1 Test Street', address_line2: 'Flat 2', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' });
    const found = await request(t.app).get(path).query({ search: '600001' });
    expect(found.body.items.map((i) => i.id)).toContain(res.body.item.id);
  });

  it('refuses a missing phone or address part with a plain message', async () => {
    const cases = [
      [{ phone: '' }, /phone number/i],
      [{ phone: undefined }, /phone number/i],
      [{ address_line1: '' }, /address/i],
      [{ city: '  ' }, /city/i],
      [{ state: '' }, /state/i],
      [{ pincode: '' }, /PIN \/ postal code/i],
      [{ pincode: '60001' }, /PIN code/i],
      [{ pincode: '60000A' }, /PIN code/i],
    ];
    for (const [overrides, message] of cases) {
      const res = await make({ phone: '+91 90000 81113', ...overrides });
      expect(res.status, JSON.stringify(overrides)).toBe(400);
      expect(res.body.error).toMatch(message);
    }
  });

  it('treats the same number written differently as a duplicate', async () => {
    const first = await make({ name: 'Zz Digits Owner', phone: '+91 98765 43210' });
    expect(first.status).toBe(201);
    for (const phone of ['098765 43210', '9876543210', '+91-98765-43210']) {
      const dup = await make({ name: 'Zz Digits Other', phone });
      expect(dup.status, phone).toBe(409);
      expect(dup.body.error).toBe(`That phone number already belongs to Zz Digits Owner (${first.body.item.code}).`);
    }
  });

  it('asks an old customer without an address for one when edited, but hiding still works', async () => {
    // a customer from the original Excel load (no phone, no address); the test connection is the app role, so one
    // cannot be inserted here and an existing one is used (all changes are rolled back at the end)
    const all = await request(t.app).get(path).query({ inactive: 'true' });
    const old = all.body.items.find((i) => !i.phone && !i.address_line1);
    if (!old) return;
    const id = old.id;
    const edit = await request(t.app).patch(`${path}/${id}`).send({ name: old.name });
    expect(edit.status).toBe(400);
    const hide = await request(t.app).post(`${path}/${id}/deactivate`);
    expect(hide.status).toBe(200);
    const fixed = await request(t.app).patch(`${path}/${id}`).send({ name: old.name, phone: '+91 90000 81114', ...ADDRESS });
    expect(fixed.status).toBe(200);
  });

  it('takes a customer in another country: free-text region, postal code, full phone number', async () => {
    const uk = await make({
      name: 'Zz London Customer', phone: '+44 7700 900123', country: 'United Kingdom', state: 'England', city: 'London', pincode: 'SW1A 1AA',
    });
    expect(uk.status).toBe(201);
    expect(uk.body.item).toMatchObject({ country: 'United Kingdom', state: 'England', pincode: 'SW1A 1AA' });
    const found = await request(t.app).get(path).query({ search: 'united kingdom' });
    expect(found.body.items.map((i) => i.id)).toContain(uk.body.item.id);
  });

  it('keeps the India rules for India and refuses unknown countries', async () => {
    const ukCodeInIndia = await make({ phone: '+91 90000 82221', pincode: 'SW1A 1AA' });
    expect(ukCodeInIndia.status).toBe(400);
    expect(ukCodeInIndia.body.error).toMatch(/PIN code/i);

    const pinInUk = await make({ phone: '+91 90000 82222', country: 'United Kingdom', pincode: '1' });
    expect(pinInUk.status).toBe(400);
    expect(pinInUk.body.error).toMatch(/postal code/i);

    for (const country of ['india', 'Narnia', '']) {
      const bad = await make({ phone: '+91 90000 82223', country });
      expect(bad.status, country).toBe(400);
      expect(bad.body.error).toMatch(/country/i);
    }
    const noCountry = await make({ phone: '+91 90000 82224', country: undefined });
    expect(noCountry.status).toBe(400);
  });

  it('does not mix up numbers from different countries that end in the same 10 digits', async () => {
    const india = await make({ name: 'Zz India Number', phone: '+91 98765 11111' });
    expect(india.status).toBe(201);
    const abroad = await make({ name: 'Zz Abroad Number', phone: '+44 98765 11111', country: 'United Kingdom', state: 'England', pincode: 'SW1A 1AA' });
    expect(abroad.status).toBe(201);
    const again = await make({ name: 'Zz India Again', phone: '098765 11111' });
    expect(again.status).toBe(409);
  });

  it('requires 10 digits for India and the country code abroad', async () => {
    for (const phone of ['98765 4321', '9876543', '+91 98765 4321', '987654321012']) {
      const bad = await make({ phone });
      expect(bad.status, phone).toBe(400);
      expect(bad.body.error, phone).toMatch(/10 digits/);
    }
    for (const [phone, message] of [['7700 900123', /country code/], ['+44 770', /too short/], ['+44 7700 90012345678', /too short or too long/]]) {
      const bad = await make({ phone, country: 'United Kingdom', state: 'England', pincode: 'SW1A 1AA' });
      expect(bad.status, phone).toBe(400);
      expect(bad.body.error, phone).toMatch(message);
    }
    // all the ways of writing a valid Indian number, and a short foreign one that carries its country code
    for (const [i, phone] of ['98765 22221', '098765 22222', '+91 98765 22223', '0091 98765 22224'].entries()) {
      const ok = await make({ name: `Zz Ten Digits ${i}`, phone });
      expect(ok.status, phone).toBe(201);
    }
    const sg = await make({ name: 'Zz Singapore', phone: '+65 8123 4567', country: 'Singapore', state: 'Singapore', pincode: '049145' });
    expect(sg.status).toBe(201);
  });

  it('lists the countries with India first', async () => {
    const res = await request(t.app).get('/api/customers/countries');
    expect(res.status).toBe(200);
    expect(res.body.countries[0]).toBe('India');
    expect(res.body.countries).toContain('United Kingdom');
  });

  it('suppliers are unchanged: phone stays optional and no address is needed', async () => {
    const res = await request(t.app).post('/api/suppliers').send({ name: 'Zz Plain Supplier' });
    expect(res.status).toBe(201);
    expect(res.body.item.phone).toBeNull();
  });
});
