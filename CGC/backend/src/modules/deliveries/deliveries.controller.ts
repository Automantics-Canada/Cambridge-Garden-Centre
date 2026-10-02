import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { DeliveriesService, DeliveryNotCurrentError } from './deliveries.service.js';
import { prisma } from '../../db/prisma.js';
import { canAccessDelivery, findDriverIdForUser } from '../../services/authorization.js';
import {
  evaluateTransition,
  DENIAL_HTTP_STATUS,
  FINISHED_STOP_REFUSAL,
  isLockedFinishedStop,
} from './deliveryTransitions.js';
import { DeliveryQueryError, parseDeliveryQuery } from './deliveryQuery.js';

export const getDeliveries = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = parseDeliveryQuery(req.query as Record<string, unknown>);
    const filters = parsed.filters;

    if (req.user?.role === 'DRIVER') {
      // A driver is answered with their current stop alone, whatever they ask
      // for: a hand-edited filter or page size cannot widen it to the run.
      const ownDriverId = await findDriverIdForUser(prisma, req.user.id);
      if (!ownDriverId) {
        return res.status(404).json({ error: 'Driver profile not linked' });
      }
      const current = await DeliveriesService.getCurrentStop(ownDriverId);
      return res.json(parsed.wantsEnvelope ? current : current.data);
    }

    const result = await DeliveriesService.getDeliveries(
      filters,
      parsed.page,
      parsed.limit,
      parsed.wantsEnvelope ? 'newest' : 'priority',
      'operations',
    );

    // Legacy driver links and older frontends expect an array when they did not
    // request pagination. The current operations screen always sends page/limit.
    res.json(parsed.wantsEnvelope ? result : result.data);
  } catch (error: any) {
    if (error instanceof DeliveryQueryError) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
};

/**
 * A driver may change only the stop on their screen. Answers false, having
 * replied, when they may not.
 */
async function driverMayActOn(req: AuthRequest, res: Response, deliveryId: string): Promise<boolean> {
  if (req.user?.role !== 'DRIVER') return true;
  const ownDriverId = await findDriverIdForUser(prisma, req.user.id);
  if (!ownDriverId) {
    res.status(404).json({ error: 'Driver profile not linked' });
    return false;
  }
  try {
    await DeliveriesService.assertCurrentStop(ownDriverId, deliveryId);
    return true;
  } catch (error) {
    if (error instanceof DeliveryNotCurrentError) {
      res.status(409).json({ error: error.message, code: error.code });
      return false;
    }
    throw error;
  }
}

export const updateStatus = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    if (!(await canAccessDelivery(prisma, req.user, id))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!(await driverMayActOn(req, res, id))) return;
    const { status, notes } = req.body;

    // The state machine needs the current record. Reading it here rather than
    // inside the service keeps the denial an HTTP concern and avoids a second
    // lookup: the service re-reads inside its transaction to close the race.
    const current = await prisma.delivery.findUnique({
      where: { id },
      select: { status: true, pickupPhotoUrl: true, deliveryPhotoUrl: true },
    });
    if (!current) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const decision = evaluateTransition({
      from: current.status,
      to: status,
      role: req.user!.role,
      evidence: {
        pickupPhotoUrl: current.pickupPhotoUrl,
        deliveryPhotoUrl: current.deliveryPhotoUrl,
      },
    });

    if (!decision.allowed) {
      return res
        .status(DENIAL_HTTP_STATUS[decision.code])
        .json({ error: decision.reason, code: decision.code });
    }

    const delivery = await DeliveriesService.updateStatus(
      id,
      decision.to,
      notes,
      current.status
    );
    res.json(delivery);
  } catch (error: any) {
    if (error?.code === 'DELIVERY_TRANSITION_CONFLICT') {
      return res.status(409).json({ error: error.message, code: 'ILLEGAL_TRANSITION' });
    }
    res.status(500).json({ error: error.message });
  }
};

export const uploadPhoto = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    if (!(await canAccessDelivery(prisma, req.user, id))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!(await driverMayActOn(req, res, id))) return;

    // A finished stop's photos are its proof of delivery; replacing one is a
    // correction to history, which only an admin or owner may make. A driver
    // has already been held to their current stop, which is never finished.
    if (req.user!.role !== 'DRIVER') {
      const stop = await prisma.delivery.findUnique({ where: { id }, select: { status: true } });
      if (!stop) {
        return res.status(404).json({ error: 'Delivery not found' });
      }
      if (isLockedFinishedStop(stop.status, req.user!.role)) {
        return res.status(403).json({ error: FINISHED_STOP_REFUSAL, code: 'FINISHED_STOP_ADMIN_ONLY' });
      }
    }

    const { type } = req.body; // 'pickup' | 'delivery' | 'ticket'

    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }
    if (!type || (type !== 'pickup' && type !== 'delivery' && type !== 'ticket')) {
      return res.status(400).json({ error: 'Valid type (pickup, delivery, or ticket) is required' });
    }

    const delivery = await DeliveriesService.uploadPhoto(id, type, req.file.buffer, req.file.originalname);
    res.json(delivery);
  } catch (error: any) {
    res.status(500).json({ error: error.message }); 
  }
};
