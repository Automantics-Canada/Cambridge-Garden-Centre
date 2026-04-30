import { Router } from 'express';
import multer from 'multer';
import { getDeliveries, updateStatus, uploadPhoto } from './deliveries.controller.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/', getDeliveries);
router.post('/:id/status', updateStatus);
router.post('/:id/photos', upload.single('file'), uploadPhoto);

export default router;
