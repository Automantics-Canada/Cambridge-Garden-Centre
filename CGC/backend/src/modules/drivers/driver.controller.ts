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
    const { name, phone, email, type, ratePerDelivery, ratePerTrip, active } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }
    const driver = await DriverService.createDriver({ 
      name, phone, email, type, 
      ratePerDelivery: Number(ratePerDelivery || 0), 
      ratePerTrip: Number(ratePerTrip || ratePerDelivery || 0),
      active 
    });
    res.status(201).json(driver);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const updateDriver = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const data = req.body;
    
    // Convert to number if passed as string
    if (data.ratePerDelivery !== undefined) data.ratePerDelivery = Number(data.ratePerDelivery);
    if (data.ratePerTrip !== undefined) data.ratePerTrip = Number(data.ratePerTrip);

    const driver = await DriverService.updateDriver(id, data);
    res.json(driver);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getDriverDeliveries = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const deliveries = await DriverService.getDriverDeliveries(id);
    res.json(deliveries);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
