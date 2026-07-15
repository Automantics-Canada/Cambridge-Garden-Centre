import { Router } from 'express';
import multer from 'multer';
import { importOrdersFromCsv, importOrdersFromPdf, getOrders, streamPdfImport } from './order.controller.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { UserRole } from '@prisma/client';
const router = Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});
router.use(authMiddleware);
router.get('/', getOrders);
router.get('/import/stream', streamPdfImport);
router.post('/import', requireRole([UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN]), upload.single('file'), importOrdersFromCsv);
router.post('/import-pdf', requireRole([UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN]), upload.single('file'), importOrdersFromPdf);
export default router;
//# sourceMappingURL=order.routes.js.map