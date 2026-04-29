import { Router } from 'express';
import { getDrivers, createDriver, getDriverDeliveries } from './driver.controller.js';

const router = Router();

router.get('/', getDrivers);
router.post('/', createDriver);
router.get('/:id/deliveries', getDriverDeliveries);

export default router;
