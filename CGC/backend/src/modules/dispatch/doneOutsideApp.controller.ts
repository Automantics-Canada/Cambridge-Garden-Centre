import type { Response } from 'express';

import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { DoneOutsideAppError, markDoneOutsideApp } from './doneOutsideApp.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Marks an order delivered outside the app. Office roles only (the dispatch
 * router's guard). Two clicks at once meet the one-stop-per-order rule; the
 * second is told to refresh, not shown a 500.
 */
export const markOrderDoneOutsideApp = async (req: AuthRequest, res: Response) => {
  const documentId = req.params.documentId as string;
  // Not an order id at all: no such order, without asking the database.
  if (!UUID.test(documentId)) return res.status(404).json({ error: 'That order no longer exists.' });
  try {
    const result = await markDoneOutsideApp(documentId, req.user!.id);
    return res.json(result);
  } catch (error: any) {
    if (error instanceof DoneOutsideAppError) return res.status(error.status).json({ error: error.message });
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'Someone else just changed this order. Refresh the board.' });
    }
    console.error('[DoneOutsideApp] Failed', error);
    return res.status(500).json({ error: 'The order could not be marked. Nothing was changed; try again.' });
  }
};
