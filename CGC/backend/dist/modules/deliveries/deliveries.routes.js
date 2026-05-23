import { Router } from 'express';
import multer from 'multer';
import { authMiddleware } from '../../middleware/authMiddleware.js';
import { getDeliveries, updateStatus, uploadPhoto } from './deliveries.controller.js';
const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
// Protect all delivery routes
router.use(authMiddleware);
router.get('/', getDeliveries);
router.patch('/:id/status', updateStatus);
router.post('/:id/photos', upload.single('file'), uploadPhoto);
export default router;
//# sourceMappingURL=deliveries.routes.js.map