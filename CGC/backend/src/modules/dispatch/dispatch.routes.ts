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

export default router;
