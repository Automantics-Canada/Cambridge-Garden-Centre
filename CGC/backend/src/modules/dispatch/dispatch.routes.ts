import { Router } from 'express';
import {
  getDispatchBoard,
  getUpcoming,
  getUndatedOrders,
  assignDriver,
  unassignDriver,
  reorderDeliveries,
  resendEmail,
} from './dispatch.controller.js';
import { markOrderDoneOutsideApp } from './doneOutsideApp.controller.js';
import {
  copyLoadRateToTrip,
  createOrderLoad,
  deleteLoad,
  listOrderLoads,
  updateLoad,
} from './dispatchLoads.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';

const router = Router();

router.use(authMiddleware, requireRole(['AP_USER', 'OWNER', 'ADMIN']));

router.get('/', getDispatchBoard);
router.get('/upcoming', getUpcoming);
router.get('/pickups', getUndatedOrders);
router.post('/assign', assignDriver);
router.post('/unassign', unassignDriver);
router.post('/reorder', reorderDeliveries);
router.post('/resend-email/:deliveryId', resendEmail);
// The office marks an order delivered that went out without the app.
router.post('/orders/:documentId/done-outside-app', markOrderDoneOutsideApp);
// The loads dispatch sends for an order and the haul rate agreed for each
// (client, Q14). Money: office roles only, like the rest of this router.
router.get('/orders/:documentId/loads', listOrderLoads);
router.post('/orders/:documentId/loads', createOrderLoad);
router.patch('/loads/:loadId', updateLoad);
router.delete('/loads/:loadId', deleteLoad);
router.post('/loads/:loadId/copy-rate-to-trip', copyLoadRateToTrip);

export default router;
