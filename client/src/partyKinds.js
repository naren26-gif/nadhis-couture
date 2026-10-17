// What differs between the supplier and customer screens. Everything else is shared.
export const PARTY_KINDS = {
  supplier: {
    noun: 'supplier',
    plural: 'Suppliers',
    path: '/suppliers',
    hasContactPerson: true,
    hideNote: 'It will vanish from supplier lists and dropdowns. Past purchases and payments are kept.',
  },
  customer: {
    noun: 'customer',
    plural: 'Customers',
    path: '/customers',
    hasContactPerson: false,
    hideNote: 'It will vanish from customer lists and dropdowns. Past orders and payments are kept.',
  },
};
