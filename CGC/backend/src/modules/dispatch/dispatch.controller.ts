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
