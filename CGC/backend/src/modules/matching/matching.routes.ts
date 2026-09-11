import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../../db/prisma.js';
import { authMiddleware, requireRole, type AuthRequest } from '../../middleware/authMiddleware.js';
import { matchInvoiceById, matchTicketById } from './matching.service.js';
import { reopenMatchResult, resolveMatchResult, type ResolutionInput } from './resolveMatch.js';

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

const RESOLUTIONS: ResolutionInput[] = ['CONFIRMED', 'OVERRIDDEN', 'REJECTED'];

/** Turns a refusal from the service into the right status and a plain reason. */
function explain(code: string): { status: number; error: string } {
  switch (code) {
    case 'NOT_FOUND':
      return { status: 404, error: 'That verdict no longer exists' };
    case 'ALREADY_RESOLVED':
      return { status: 409, error: 'Someone has already settled this. Reopen it first.' };
    case 'ORDER_REQUIRED':
      return { status: 400, error: 'Choose the order this belongs to' };
    case 'NOTE_REQUIRED':
      return { status: 400, error: 'Say why, so the decision can be understood later' };
    case 'ORDER_NOT_FOUND':
      return { status: 400, error: 'That order does not exist' };
    default:
      return { status: 400, error: 'That resolution could not be applied' };
  }
}

/** Settle one verdict: accept it, point it at a different order, or reject it. */
router.post('/results/:id/resolve', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const { resolution, orderId, note } = req.body ?? {};
  if (!RESOLUTIONS.includes(resolution)) {
    return res.status(400).json({ error: `resolution must be one of ${RESOLUTIONS.join(', ')}` });
  }

  try {
    const outcome = await resolveMatchResult({
      matchResultId: req.params.id as string,
      resolution,
      orderId,
      note,
      userId: user.id,
    });

    if (!outcome.ok) {
      const { status, error } = explain(outcome.code);
      return res.status(status).json({ error });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('[Matching] resolve failed:', error);
    return res.status(500).json({ error: 'Could not record that decision' });
  }
});

/** Reopen a settled verdict so it can be decided again. */
router.post('/results/:id/reopen', async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user;
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  try {
    const outcome = await reopenMatchResult({
      matchResultId: req.params.id as string,
      note: req.body?.note,
      userId: user.id,
    });

    if (!outcome.ok) {
      const { status, error } = explain(outcome.code);
      return res.status(status).json({ error });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('[Matching] reopen failed:', error);
    return res.status(500).json({ error: 'Could not reopen that verdict' });
  }
});

export default router;
