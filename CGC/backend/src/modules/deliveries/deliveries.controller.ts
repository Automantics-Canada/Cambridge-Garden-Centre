import type { Request, Response } from 'express';
import { DeliveriesService } from './deliveries.service.js';

export const getDeliveries = async (req: Request, res: Response) => {
  try {
    const { driverId, status, priority } = req.query;
    const filters: any = {};
    if (driverId) filters.driverId = driverId;
    if (status) filters.status = status;
    if (priority) filters.priority = Number(priority);

    const deliveries = await DeliveriesService.getDeliveries(filters);
    res.json(deliveries);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const delivery = await DeliveriesService.updateStatus(id, status, notes);
    res.json(delivery);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const uploadPhoto = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { type } = req.body; // 'pickup' | 'delivery'
    
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }
    if (!type || (type !== 'pickup' && type !== 'delivery')) {
      return res.status(400).json({ error: 'Valid type (pickup or delivery) is required' });
    }

    const delivery = await DeliveriesService.uploadPhoto(id, type, req.file.buffer, req.file.originalname);
    res.json(delivery);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
