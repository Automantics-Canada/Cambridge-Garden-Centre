import type { Response } from 'express';
import { SupplierService } from './supplier.service.js';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { SupplierType } from '@prisma/client';

export const listSuppliers = async (_req: AuthRequest, res: Response) => {
  const suppliers = await SupplierService.list();
  res.json(suppliers);
};

export const createSupplier = async (req: AuthRequest, res: Response) => {
  const { name, type, emailDomains, contactName, contactEmail, phone, address } =
    req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }

  // Validate that type is a valid SupplierType
  if (!Object.values(SupplierType).includes(type)) {
    return res.status(400).json({ error: `Invalid supplier type: ${type}` });
  }

  const supplier = await SupplierService.create({
    name,
    type,
    emailDomains: emailDomains ?? [],
    contactName,
    contactEmail,
    phone,
    address,
  });

  res.status(201).json(supplier);
};

export const updateSupplier = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const data = req.body;

  const supplier = await SupplierService.update(id as string, data);
  res.json(supplier);
};

export const deleteSupplier = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const supplier = await SupplierService.remove(id as string);
  res.json(supplier);
};