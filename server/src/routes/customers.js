import { buildPartyRouter } from './parties.js';

export const customersRouter = buildPartyRouter({
  noun: 'customer',
  table: 'customer',
  idColumn: 'customer_id',
  codeColumn: 'customer_code',
  prefix: 'CUST',
  width: 6, // CUST000001 (the shop's existing customer codes are 6 digits)
  hasContactPerson: false,
});
