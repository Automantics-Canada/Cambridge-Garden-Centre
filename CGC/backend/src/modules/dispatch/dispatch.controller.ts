import type { Request, Response } from 'express';
import { DispatchService } from './dispatch.service.js';
import { NotificationService } from '../../services/notification.service.js';

export const getDispatchBoard = async (req: Request, res: Response) => {
  try {
    const board = await DispatchService.getDispatchBoard();
    res.json(board);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const assignDriver = async (req: Request, res: Response) => {
  try {
    const { orderId, driverId, priority } = req.body;
    if (!orderId || !driverId) {
      return res.status(400).json({ error: 'orderId and driverId are required' });
    }
    const delivery = await DispatchService.assignDriver(orderId, driverId, priority);
    
    // Trigger notification
    await NotificationService.sendAssignmentNotification(driverId, [delivery]);

    res.json(delivery);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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
