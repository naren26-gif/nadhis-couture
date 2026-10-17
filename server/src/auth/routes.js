import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { login, logout, currentUser } from './index.js';
import { UserError } from '../errors.js';

export const authRouter = Router();

// 5 wrong tries per 15 minutes per address (only failed attempts count)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

const loginSchema = z.object({
  email: z.string({ required_error: 'Please enter your email.' }).min(1, 'Please enter your email.'),
  password: z.string({ required_error: 'Please enter your password.' }).min(1, 'Please enter your password.'),
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await login(req, email, password);
    if (!user) throw new UserError('Wrong email or password.', 401);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    await logout(req);
    res.clearCookie('nc.sid');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', async (req, res, next) => {
  try {
    res.json({ user: await currentUser(req) });
  } catch (err) {
    next(err);
  }
});
