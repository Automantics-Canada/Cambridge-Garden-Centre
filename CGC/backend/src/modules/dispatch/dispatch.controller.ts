import type { Request, Response } from 'express';
import { DispatchService } from './dispatch.service.js';
import { NotificationService } from '../../services/notification.service.js';

export const getDispatchBoard = async (req: Request, res: Response) => {
  try {
    const day = typeof req.query.date === 'string' ? req.query.date : undefined;
    const board = await DispatchService.getDispatchBoard(day);
    res.json(board);
  } catch (error: any) {
    // A bad `date` is a 400. Reporting it as a 500 would send the caller
    // looking for a server fault instead of fixing the parameter.
    const status = Number(error?.status) || 500;
    res.status(status).json({ error: error.message });
  }
};

/**
 * A refusal the service explained — no such order, already delivered — keeps
 * its status. Two dispatchers giving one order to two drivers at the same
 * moment meet the one-stop-per-order rule; the second is told, not shown a 500.
 */
function sendDispatchError(res: Response, error: any) {
  if (error?.code === 'P2002') {
    return res.status(409).json({ error: 'Someone else just dispatched this order. Refresh the board.' });
  }
  const status = Number(error?.status) || 500;
  return res.status(status).json({ error: error.message });
}

/**
 * Gives an order to a driver. `documentId` names a whole Spruce order;
 * `orderId` names a single line, for stops made before orders were dispatched
 * whole and for a screen still open from before this change.
 */
export const assignDriver = async (req: Request, res: Response) => {
  try {
    const { documentId, orderId, driverId, priority } = req.body;
    if ((!documentId && !orderId) || !driverId) {
      return res.status(400).json({ error: 'documentId (or orderId) and driverId are required' });
    }
    const delivery = documentId
      ? await DispatchService.assignOrder(documentId, driverId)
      : await DispatchService.assignDriver(orderId, driverId, priority);
    res.json(delivery);
  } catch (error: any) {
    sendDispatchError(res, error);
  }
};

export const unassignDriver = async (req: Request, res: Response) => {
  try {
    const { documentId, orderId } = req.body;
    if (!documentId && !orderId) {
      return res.status(400).json({ error: 'documentId (or orderId) is required' });
    }
    const result = documentId
      ? await DispatchService.unassignOrder(documentId)
      : await DispatchService.unassignDriver(orderId);
    res.json(result);
  } catch (error: any) {
    sendDispatchError(res, error);
  }
};

export const reorderDeliveries = async (req: Request, res: Response) => {
  try {
    const { driverId, deliveryIds } = req.body;
    if (!driverId || !Array.isArray(deliveryIds)) {
      return res.status(400).json({ error: 'driverId and deliveryIds (array) are required' });
    }
    const result = await DispatchService.reorderDeliveries(driverId, deliveryIds);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const resendEmail = async (req: Request, res: Response) => {
  try {
    const deliveryId = req.params.deliveryId as string;
    const result = await DispatchService.resendAssignmentEmail(deliveryId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
