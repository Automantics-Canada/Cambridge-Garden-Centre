import { Router, type Response } from 'express';
import { EmailIngestionStatus, UserRole } from '@prisma/client';
import { authMiddleware, requireRole, type AuthRequest } from '../../middleware/authMiddleware.js';
import { EmailEventService, isUuid } from './emailEvents.service.js';

/**
 * The email review queue. Office roles only; drivers never see supplier mail.
 *
 *   GET  /api/email-events?status=NEEDS_REVIEW|IGNORED   the queue (default) or the ignored list
 *   POST /api/email-events/:id/approve   { supplierId | newSupplier: { name, type }, match: address|domain }
 *   POST /api/email-events/:id/ignore
 *
 * Approving adds a sender to a supplier, which decides whose invoices are read
 * automatically, so it and ignoring are OWNER/ADMIN only. AP_USER may view.
 */
const router = Router();
const OFFICE = [UserRole.AP_USER, UserRole.OWNER, UserRole.ADMIN];
const MANAGERS = [UserRole.OWNER, UserRole.ADMIN];

router.use(authMiddleware);
router.use(requireRole(OFFICE));

router.get('/', async (req: AuthRequest, res: Response) => {
  const raw = typeof req.query.status === 'string' ? req.query.status : EmailIngestionStatus.NEEDS_REVIEW;
  if (raw !== EmailIngestionStatus.NEEDS_REVIEW && raw !== EmailIngestionStatus.IGNORED) {
    return res.status(400).json({ error: 'status must be NEEDS_REVIEW or IGNORED' });
  }
  res.set('Cache-Control', 'no-store').json(await EmailEventService.list(raw));
});

router.post('/:id/approve', requireRole(MANAGERS), async (req: AuthRequest, res: Response) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Email not found' });
  const result = await EmailEventService.approveSender(req.params.id as string, req.body ?? {}, req.user!.id);
  res.json(result);
});

router.post('/:id/ignore', requireRole(MANAGERS), async (req: AuthRequest, res: Response) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Email not found' });
  res.json(await EmailEventService.ignore(req.params.id as string, req.user!.id));
});

export default router;
