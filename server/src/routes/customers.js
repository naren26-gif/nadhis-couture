import { buildPartyRouter } from './parties.js';

export const customersRouter = buildPartyRouter({
  noun: 'customer',
  table: 'customer',
  idColumn: 'customer_id',
  codeColumn: 'customer_code',
  sequence: 'customer_code_seq',
  prefix: 'CUST',
  hasContactPerson: false,
});
