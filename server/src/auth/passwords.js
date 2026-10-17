import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// A real-looking hash to compare against when the email is unknown, so "no such user" takes as long as "wrong password".
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

export const MIN_PASSWORD_LENGTH = 10;
