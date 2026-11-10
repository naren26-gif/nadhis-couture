// States and union territories for the customer address dropdown.
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

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
    hasAddress: true, // phone and one delivery address are required
    hideNote: 'It will vanish from customer lists and dropdowns. Past orders and payments are kept.',
  },
};
