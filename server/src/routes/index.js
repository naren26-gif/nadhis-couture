// Every screen's API lives behind login. app.js and the tests both mount this one router at /api.
import { Router } from 'express';
import { requireLogin } from '../auth/index.js';
import { lookupsRouter } from './lookups.js';
import { productsRouter } from './products.js';
import { variantsRouter } from './variants.js';

export const protectedRouter = Router();

protectedRouter.use(requireLogin);
protectedRouter.use('/lookups', lookupsRouter);
protectedRouter.use('/products', productsRouter);
protectedRouter.use('/variants', variantsRouter);
