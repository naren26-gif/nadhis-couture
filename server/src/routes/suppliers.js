import { buildPartyRouter } from './parties.js';

export const suppliersRouter = buildPartyRouter({
  noun: 'supplier',
  table: 'supplier',
  idColumn: 'supplier_id',
  codeColumn: 'supplier_code',
  sequence: 'supplier_code_seq',
  prefix: 'SPLR',
  hasContactPerson: true,
});
