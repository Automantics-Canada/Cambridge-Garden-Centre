import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { OrderImportService, OrderService } from './order.service.js';
import { OrderPdfImportService } from './orderPdfImport.service.js';
export const importOrdersFromCsv = async (req: AuthRequest, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  }

  try {
    const summary = await OrderImportService.importFromCsv(file.buffer, file.originalname);

    return res.status(200).json({
      message: 'Import completed',
      ...summary,
    });
  } catch (err: any) {
    console.error('Order import error', err);
    return res
      .status(500)
      .json({ error: err?.message || 'Unexpected error during import' });
  }
};

export const importOrdersFromPdf = async (req: AuthRequest, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'PDF file is required (field name: file)' });
  }

  try {
    const summary = await OrderPdfImportService.importFromPdf(file.buffer);

    return res.status(200).json({
      message: 'PDF Import completed',
      ...summary,
    });
  } catch (err: any) {
    console.error('Order PDF import error', err);
    return res
      .status(500)
      .json({ error: err?.message || 'Unexpected error during PDF import' });
  }
};

export const getOrders = async (req: AuthRequest, res: Response) => {
  try {
    const orders = await OrderService.getOrders(req.query);
    return res.status(200).json(orders);
  } catch (err: any) {
    console.error('Error fetching orders', err);
    return res
      .status(500)
      .json({ error: err?.message || 'Unexpected error fetching orders' });
  }
};