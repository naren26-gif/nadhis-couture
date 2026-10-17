// Every screen's API lives behind login. app.js and the tests both mount this one router at /api.
import { Router } from 'express';
import { requireLogin } from '../auth/index.js';
import { courierRouter } from './courier.js';
import { customersRouter } from './customers.js';
import { inventoryRouter } from './inventory.js';
import { ordersRouter } from './orders.js';
import { purchasesRouter } from './purchases.js';
import { reportsRouter } from './reports.js';
import { shipmentsRouter } from './shipments.js';
import { suppliersRouter } from './suppliers.js';
import { lookupsRouter } from './lookups.js';
import { productsRouter } from './products.js';
import { variantsRouter } from './variants.js';

export const protectedRouter = Router();

protectedRouter.use(requireLogin);
protectedRouter.use('/courier', courierRouter);
protectedRouter.use('/customers', customersRouter);
protectedRouter.use('/inventory', inventoryRouter);
protectedRouter.use('/orders', ordersRouter);
protectedRouter.use('/purchases', purchasesRouter);
protectedRouter.use('/reports', reportsRouter);
protectedRouter.use('/shipments', shipmentsRouter);
protectedRouter.use('/suppliers', suppliersRouter);
protectedRouter.use('/lookups', lookupsRouter);
protectedRouter.use('/products', productsRouter);
protectedRouter.use('/variants', variantsRouter);
