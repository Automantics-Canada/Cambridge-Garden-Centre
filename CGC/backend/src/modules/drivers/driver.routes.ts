import { Router } from 'express';
import { authMiddleware } from '../../middleware/authMiddleware.js';
import { 
  getDrivers, 
  createDriver, 
  getDriverDeliveries, 
  updateDriver,
  getLoggedInDriverProfile,
  deleteDriver
} from './driver.controller.js';

const router = Router();

// Protect all driver routes
router.use(authMiddleware);

router.get('/me', getLoggedInDriverProfile);
router.get('/', getDrivers);
router.post('/', createDriver);
router.patch('/:id', updateDriver);
router.delete('/:id', deleteDriver);
router.get('/:id/deliveries', getDriverDeliveries);

export default router;

