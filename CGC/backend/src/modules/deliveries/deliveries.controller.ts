import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { DeliveriesService } from './deliveries.service.js';
import { prisma } from '../../db/prisma.js';
import { canAccessDelivery, findDriverIdForUser } from '../../services/authorization.js';
import { evaluateTransition, DENIAL_HTTP_STATUS } from './deliveryTransitions.js';

export const getDeliveries = async (req: AuthRequest, res: Response) => {
  try {
    const { driverId, status, priority } = req.query;
    const filters: any = {};

    if (req.user?.role === 'DRIVER') {
      // Securely enforce that drivers can only query their own deliveries
      const ownDriverId = await findDriverIdForUser(prisma, req.user.id);
      if (!ownDriverId) {
        return res.status(404).json({ error: 'Driver profile not linked' });
      }
      filters.driverId = ownDriverId;
    } else {
      if (driverId) filters.driverId = driverId;
    }

    if (status) filters.status = status;
    if (priority) filters.priority = Number(priority);

    const deliveries = await DeliveriesService.getDeliveries(filters);
    res.json(deliveries);
  } catch (error: any) {
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
