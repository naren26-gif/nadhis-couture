// The ONLY door to login/authentication. The rest of the app uses just these functions, so moving to
// Amazon Cognito later means rewriting this folder and nothing else.
//   sessionMiddleware(config)  - sets up login cookies
//   login(req, email, password)- checks credentials, starts a session, returns the user (or null)
//   logout(req)                - ends the session
//   currentUser(req)           - the logged-in user or null
//   requireLogin / requireRole - route guards
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { getPool, query } from '../db.js';
import { UserError } from '../errors.js';
import { checkPassword, DUMMY_HASH } from './passwords.js';

const SESSION_HOURS = 12;

export function sessionMiddleware(config) {
  const PgStore = connectPgSimple(session);
  return session({
    store: new PgStore({ pool: getPool(), tableName: 'app_session' }),
    name: 'nc.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // active people stay logged in; idle ones are logged out after SESSION_HOURS
    cookie: {
      httpOnly: true, // JavaScript in the browser cannot read the cookie
      sameSite: 'lax',
      secure: config.isProduction, // https only when deployed
      maxAge: SESSION_HOURS * 60 * 60 * 1000,
    },
  });
}

function publicUser(row) {
  return { id: row.user_id, email: row.email, name: row.display_name, role: row.role };
}

export async function login(req, email, password) {
  const { rows } = await query(
    `SELECT user_id, email, display_name, role, password_hash, is_active
       FROM app_user WHERE email = $1`,
    [String(email).trim().toLowerCase()],
  );
  const row = rows[0];
  const ok = await checkPassword(String(password), row ? row.password_hash : DUMMY_HASH);
  if (!row || !row.is_active || !ok) return null;

  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = row.user_id;
  await query('UPDATE app_user SET last_login_at = now() WHERE user_id = $1', [row.user_id]);
  return publicUser(row);
}

export function logout(req) {
  return new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
}

// Loads the user for this request (once) and checks they are still active.
export async function currentUser(req) {
  if (req.user !== undefined) return req.user;
  req.user = null;
  if (req.session?.userId) {
    const { rows } = await query(
      'SELECT user_id, email, display_name, role FROM app_user WHERE user_id = $1 AND is_active',
      [req.session.userId],
    );
    if (rows[0]) req.user = publicUser(rows[0]);
  }
  return req.user;
}

export async function requireLogin(req, res, next) {
  try {
    if (!(await currentUser(req))) throw new UserError('Please log in to continue.', 401);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const user = await currentUser(req);
      if (!user) throw new UserError('Please log in to continue.', 401);
      if (!roles.includes(user.role)) throw new UserError('Only the owner can do that.', 403);
      next();
    } catch (err) {
      next(err);
    }
  };
}
