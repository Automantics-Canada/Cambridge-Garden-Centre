import type { Response } from 'express';

import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { LoadInputError } from './dispatchLoadRules.js';
import { DispatchLoadError, DispatchLoadsService } from './dispatchLoads.service.js';

/**
 * Dispatch loads and their haul rates. Office roles only (the dispatch
 * router's guard); a driver is refused before any of this runs.
 *
 * A refusal the service explained keeps its status. Two dispatchers adding a
 * load to one order at the same moment meet the one-number-per-load rule; the
 * second is told to refresh, not shown a 500.
 */
function sendLoadError(res: Response, error: any, fallback: string) {
  if (error instanceof DispatchLoadError || error instanceof LoadInputError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error?.code === 'P2002') {
    return res.status(409).json({ error: 'Someone else just added a load to this order. Refresh and try again.' });
  }
  console.error('[DispatchLoads] Failed', error);
  return res.status(500).json({ error: fallback });
}

export const listOrderLoads = async (req: AuthRequest, res: Response) => {
  try {
    res.json(await DispatchLoadsService.list(req.params.documentId as string));
  } catch (error) {
    sendLoadError(res, error, 'The loads could not be read. Try again.');
  }
};

export const createOrderLoad = async (req: AuthRequest, res: Response) => {
  try {
    res.status(201).json(await DispatchLoadsService.create(req.params.documentId as string, req.body, req.user!.id));
  } catch (error) {
    sendLoadError(res, error, 'The load could not be saved. Nothing was changed; try again.');
  }
};

export const updateLoad = async (req: AuthRequest, res: Response) => {
  try {
    res.json(await DispatchLoadsService.update(req.params.loadId as string, req.body, req.user!.id));
  } catch (error) {
    sendLoadError(res, error, 'The load could not be saved. Nothing was changed; try again.');
  }
};

export const deleteLoad = async (req: AuthRequest, res: Response) => {
  try {
    res.json(await DispatchLoadsService.remove(req.params.loadId as string, req.user!.id));
  } catch (error) {
    sendLoadError(res, error, 'The load could not be removed. Nothing was changed; try again.');
  }
};

export const copyLoadRateToTrip = async (req: AuthRequest, res: Response) => {
  try {
    res.json(await DispatchLoadsService.copyRateToTrip(req.params.loadId as string, req.user!.id));
  } catch (error) {
    sendLoadError(res, error, 'The rate could not be copied. Nothing was changed; try again.');
  }
};
