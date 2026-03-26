import type { Response } from 'express';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { OrderImportService } from './order.service.js';

export const importOrdersFromCsv = async (req: AuthRequest, res: Response) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  }

  try {
    const summary = await OrderImportService.importFromCsv(file.buffer);

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