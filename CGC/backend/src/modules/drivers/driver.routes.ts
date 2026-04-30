import { Router } from 'express';
import { getDrivers, createDriver, getDriverDeliveries, updateDriver } from './driver.controller.js';

const router = Router();

router.get('/', getDrivers);
router.post('/', createDriver);
router.patch('/:id', updateDriver);
router.get('/:id/deliveries', getDriverDeliveries);

export default router;
