// Phone number rules for customers. They match the database (phone_key() and the trigger in migration 008).
//   India:         10 digits (an Indian mobile or area-code number). "+91" or a leading 0 in front is fine.
//   Other country: must start with + (or 00) and the country code; 8 to 15 digits in total (the international maximum).
import { HOME_COUNTRY } from './countries.js';

const INTERNATIONAL = /^\s*(\+|00)/;

// Returns a plain-English problem, or null when the number is acceptable for that country.
export function phoneProblem(country, phone) {
  const digits = phone.replace(/\D/g, '');
  const international = INTERNATIONAL.test(phone);
  if (country === HOME_COUNTRY) {
    const national = international ? digits.replace(/^00/, '') : digits;
    const ok = international
      ? /^91[0-9]{10}$/.test(national)
      : /^[0-9]{10}$/.test(national) || /^0[0-9]{10}$/.test(national) || /^91[0-9]{10}$/.test(national);
    return ok ? null : 'The phone number must have 10 digits (for example 98765 43210). A +91 or 0 in front is fine.';
  }
  if (!international) return 'Please start the phone number with the country code, for example +44 7700 900123.';
  const length = digits.replace(/^00/, '').length;
  if (length < 8 || length > 15) {
    return 'That phone number looks too short or too long (8 to 15 digits, including the country code).';
  }
  return null;
}
