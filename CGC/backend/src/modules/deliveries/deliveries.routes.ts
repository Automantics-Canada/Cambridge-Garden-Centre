import { Router } from 'express';
import { authMiddleware } from '../../middleware/authMiddleware.js';
import {
  createUploader,
  validateUploadContent,
  uploadErrorHandler,
} from '../../middleware/uploadValidation.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { getDeliveries, updateStatus, uploadPhoto } from './deliveries.controller.js';

const router = Router();

// Proof-of-delivery photos come straight from a phone camera. This route
// previously had no size limit and no type check at all.
const upload = createUploader({ maxBytes: 12 * 1024 * 1024, kinds: ['image'] });

// Protect all delivery routes
router.use(authMiddleware);

router.get('/', getDeliveries);
router.patch('/:id/status', updateStatus);
router.post(
  '/:id/photos',
  rateLimit({ windowMs: 60_000, max: 30, name: 'delivery photo upload' }),
  upload.single('file'),
  validateUploadContent(['image']),
  uploadPhoto
);

router.use(uploadErrorHandler);

export default router;
