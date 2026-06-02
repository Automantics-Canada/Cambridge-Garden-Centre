import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { DeliveriesService } from './deliveries.service.js';
import { prisma } from '../../db/prisma.js';

export const getDeliveries = async (req: AuthRequest, res: Response) => {
  try {
    const { driverId, status, priority } = req.query;
    const filters: any = {};

    if (req.user?.role === 'DRIVER') {
      // Securely enforce that drivers can only query their own deliveries
      const driver = await prisma.driver.findUnique({
        where: { userId: req.user.id }
      });
      if (!driver) {
        return res.status(404).json({ error: 'Driver profile not linked' });
      }
      filters.driverId = driver.id;
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
    const { status, notes } = req.body;
    const delivery = await DeliveriesService.updateStatus(id, status, notes);
    res.json(delivery);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const uploadPhoto = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
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
