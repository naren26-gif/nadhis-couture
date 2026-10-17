// All configuration comes from environment variables (so the app runs unchanged on AWS later).
// For local work we also read the git-ignored .env file in the project root, if it exists.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
try {
  process.loadEnvFile(rootEnv); // does not overwrite variables that are already set
} catch {
  // no .env file: fine, real environment variables are used instead
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing setting ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long.');
  }
  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: Number(process.env.PORT || 3000),
    dbUrl: required('APP_DB_URL'),
    sessionSecret,
  };
}

// The database-only settings, used by tests and scripts that do not need a session secret.
export function dbUrl() {
  return required('APP_DB_URL');
}
