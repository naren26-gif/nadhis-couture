// Creates a login. Run:  npm run create-user
// The password is typed at the prompt (hidden) - it is never a command-line argument and never printed.
import readline from 'node:readline';
import '../src/config.js'; // loads .env
import { query, closePool } from '../src/db.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/passwords.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
      };
    }
    rl.question(question, (answer) => {
      if (hidden) process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

try {
  const name = await ask('Display name (e.g. Nadhi): ');
  const email = (await ask('Email: ')).toLowerCase();
  const role = await ask('Role (owner or staff): ');
  const password = await ask(`Password (at least ${MIN_PASSWORD_LENGTH} characters): `, { hidden: true });
  const again = await ask('Type the password again: ', { hidden: true });

  if (!name || !email.includes('@')) throw new Error('Please give a name and a valid email.');
  if (!['owner', 'staff'].includes(role)) throw new Error('Role must be owner or staff.');
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password !== again) throw new Error('The two passwords do not match.');

  await query(
    'INSERT INTO app_user (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4)',
    [email, name, await hashPassword(password), role],
  );
  console.log(`Created ${role} login for ${email}.`);
} catch (err) {
  console.error(err.code === '23505' ? 'That email already has a login.' : `Could not create the user: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
