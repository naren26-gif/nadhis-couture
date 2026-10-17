import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import { sessionMiddleware } from './auth/index.js';
import { authRouter } from './auth/routes.js';
import { healthRouter } from './routes/health.js';
import { protectedRouter } from './routes/index.js';
import { describeError } from './errors.js';

export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1); // behind a load balancer on AWS

  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/health', healthRouter);
  app.use(sessionMiddleware(config));
  app.use('/api/auth', authRouter);

  app.use('/api', protectedRouter); // everything below needs a login; later build-order items add routers in routes/index.js

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // In production the built screens are served from the same place as the API.
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const { status, message } = describeError(err);
    res.status(status).json({ error: message });
  });

  return app;
}
