import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../db/prisma.js';
import { authMiddleware, requireRole } from '../../middleware/authMiddleware.js';
import { matchInvoiceById, matchTicketById } from './matching.service.js';

/**
 * Reading and re-running match verdicts.
 *
 * There is deliberately no endpoint here that sets a verdict directly. A person
 * resolving a CONFLICT belongs with the Verification Desk work, where they can
 * see the evidence they are deciding against; an endpoint that wrote a status
 * without that context would be the same mistake as the badge this replaced.
 */

const router = Router();

router.use(authMiddleware, requireRole(['AP_USER', 'OWNER', 'ADMIN']));

/** Counts by status: what the desk still has to work through. */
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const [byStatus, unresolved] = await Promise.all([
      prisma.matchResult.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.matchResult.count({ where: { resolution: null, status: { not: 'MATCHED' } } }),
    ]);

    const counts = Object.fromEntries(
      byStatus.map((row) => [row.status, row._count._all])
    );

    return res.json({
      counts: {
        MATCHED: counts.MATCHED ?? 0,
        PARTIAL: counts.PARTIAL ?? 0,
        UNMATCHED: counts.UNMATCHED ?? 0,
        CONFLICT: counts.CONFLICT ?? 0,
      },
      needsAPerson: unresolved,
    });
  } catch (error) {
    console.error('[Matching] summary failed:', error);
    return res.status(500).json({ error: 'Could not read match results' });
  }
});

/** Re-run one ticket. Leaves a verdict a person has already resolved alone. */
router.post('/recompute/ticket/:id', async (req: Request, res: Response) => {
  try {
    const decision = await matchTicketById(req.params.id as string);
    if (!decision) return res.status(404).json({ error: 'Ticket not found' });
    return res.json(decision);
  } catch (error) {
    console.error('[Matching] ticket recompute failed:', error);
    return res.status(500).json({ error: 'Could not evaluate this ticket' });
  }
});

/** Re-run every line on one invoice. */
router.post('/recompute/invoice/:id', async (req: Request, res: Response) => {
  try {
    const decisions = await matchInvoiceById(req.params.id as string);
    return res.json({ lines: decisions.length, decisions });
  } catch (error) {
    console.error('[Matching] invoice recompute failed:', error);
    return res.status(500).json({ error: 'Could not evaluate this invoice' });
  }
});

export default router;
