import { Router } from 'express';
import { getDispatchBoard, assignDriver, reorderDeliveries } from './dispatch.controller.js';

const router = Router();

router.get('/', getDispatchBoard);
router.post('/assign', assignDriver);
router.post('/reorder', reorderDeliveries);

export default router;
