import { Router } from 'express';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
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
router.post('/', requireRole(['OWNER', 'ADMIN']), createDriver);
router.patch('/:id', requireRole(['OWNER', 'ADMIN']), updateDriver);
router.delete('/:id', requireRole(['OWNER', 'ADMIN']), deleteDriver);
router.get('/:id/deliveries', requireRole(['AP_USER', 'OWNER', 'ADMIN']), getDriverDeliveries);

export default router;

