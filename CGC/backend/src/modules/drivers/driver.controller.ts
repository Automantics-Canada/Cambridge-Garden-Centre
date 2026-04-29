import type { Request, Response } from 'express';
import { DriverService } from './driver.service.js';

export const getDrivers = async (req: Request, res: Response) => {
  try {
    const drivers = await DriverService.getDrivers();
    res.json(drivers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createDriver = async (req: Request, res: Response) => {
  try {
    const { name, phone, ratePerDelivery } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    const driver = await DriverService.createDriver({ name, phone, ratePerDelivery: Number(ratePerDelivery) });
    res.status(201).json(driver);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getDriverDeliveries = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deliveries = await DriverService.getDriverDeliveries(id);
    res.json(deliveries);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
