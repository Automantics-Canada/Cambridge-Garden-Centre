import { Router } from 'express';
import { getDispatchBoard, assignDriver, unassignDriver, reorderDeliveries, resendEmail } from './dispatch.controller.js';

const router = Router();

router.get('/', getDispatchBoard);
router.post('/assign', assignDriver);
router.post('/unassign', unassignDriver);
router.post('/reorder', reorderDeliveries);
router.post('/resend-email/:deliveryId', resendEmail);

export default router;
