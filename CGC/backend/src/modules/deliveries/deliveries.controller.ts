import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { DeliveriesService } from './deliveries.service.js';
import { prisma } from '../../db/prisma.js';
import { canAccessDelivery, findDriverIdForUser } from '../../services/authorization.js';
import { evaluateTransition, DENIAL_HTTP_STATUS } from './deliveryTransitions.js';
import { DeliveryQueryError, parseDeliveryQuery } from './deliveryQuery.js';

export const getDeliveries = async (req: AuthRequest, res: Response) => {
  try {
    const parsed = parseDeliveryQuery(req.query as Record<string, unknown>);
    const filters = parsed.filters;

    const driverRequest = req.user?.role === 'DRIVER';
    if (req.user?.role === 'DRIVER') {
      // Securely enforce that drivers can only query their own deliveries
      const ownDriverId = await findDriverIdForUser(prisma, req.user.id);
      if (!ownDriverId) {
        return res.status(404).json({ error: 'Driver profile not linked' });
      }
      filters.driverId = ownDriverId;
      filters.status = { notIn: ['DELIVERED', 'CANCELLED'] };
    }

    const result = await DeliveriesService.getDeliveries(
      filters,
      driverRequest ? 1 : parsed.page,
      driverRequest ? 1 : parsed.limit,
      driverRequest ? 'priority' : (parsed.wantsEnvelope ? 'newest' : 'priority'),
      driverRequest ? 'driver' : 'operations',
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

export const updateStatus = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    if (!(await canAccessDelivery(prisma, req.user, id))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
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
      current.status,
      req.user?.role === 'DRIVER' ? req.user.id : undefined,
      req.user?.role === 'DRIVER' ? 'driver' : 'operations',
    );
    res.json(delivery);
  } catch (error: any) {
    if (error?.code === 'DELIVERY_TRANSITION_CONFLICT') {
      return res.status(409).json({ error: error.message, code: 'ILLEGAL_TRANSITION' });
    }
    if (error?.code === 'DELIVERY_NOT_CURRENT') {
      return res.status(403).json({ error: error.message, code: error.code });
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
    const { type } = req.body; // 'pickup' | 'delivery' | 'ticket'
    
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }
    if (!type || (type !== 'pickup' && type !== 'delivery' && type !== 'ticket')) {
      return res.status(400).json({ error: 'Valid type (pickup, delivery, or ticket) is required' });
    }

    const delivery = await DeliveriesService.uploadPhoto(
      id,
      type,
      req.file.buffer,
      req.file.originalname,
      req.user?.role === 'DRIVER' ? req.user.id : undefined,
      req.user?.role === 'DRIVER' ? 'driver' : 'operations',
    );
    res.json(delivery);
  } catch (error: any) {
    if (error?.code === 'DELIVERY_NOT_CURRENT') {
      return res.status(403).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error.message }); 
  }
};
