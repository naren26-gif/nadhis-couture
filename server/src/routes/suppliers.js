import { buildPartyRouter } from './parties.js';

export const suppliersRouter = buildPartyRouter({
  noun: 'supplier',
  table: 'supplier',
  idColumn: 'supplier_id',
  codeColumn: 'supplier_code',
  prefix: 'SPLR',
  width: 4, // SPLR0001
  hasContactPerson: true,
});
