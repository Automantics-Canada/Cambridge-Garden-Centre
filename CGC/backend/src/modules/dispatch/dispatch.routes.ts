import { Router } from 'express';
import { getDispatchBoard, assignDriver } from './dispatch.controller.js';

const router = Router();

router.get('/', getDispatchBoard);
router.post('/assign', assignDriver);

export default router;
