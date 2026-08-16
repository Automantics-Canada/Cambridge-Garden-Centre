import type { Response } from 'express';
import { SupplierService } from './supplier.service.js';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { SupplierType } from '@prisma/client';

export const listSuppliers = async (_req: AuthRequest, res: Response) => {
  const suppliers = await SupplierService.list();
  res.json(suppliers);
};

export const listSupplierOptions = async (_req: AuthRequest, res: Response) => {
  const suppliers = await SupplierService.listOptions();
  res.json(suppliers);
};

export const createSupplier = async (req: AuthRequest, res: Response) => {
  const { name, type, emailDomains, keywords, contactName, contactEmail, phone, address } =
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
    keywords: keywords ?? [],
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

export const addRate = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user?.id;
  
  if (!userId) {
    return res.status(401).json({ error: 'User ID missing in token' });
  }

  const { productName, rate, unit, effectiveFrom, effectiveTo, notes } = req.body;

  if (!productName || rate === undefined || !unit || !effectiveFrom) {
    return res.status(400).json({ error: 'productName, rate, unit, and effectiveFrom are required' });
  }

  const newRate = await SupplierService.addNegotiatedRate(id as string, {
    productName,
    rate: Number(rate),
    unit,
    effectiveFrom: new Date(effectiveFrom),
    ...(effectiveTo ? { effectiveTo: new Date(effectiveTo) } : {}),
    ...(notes !== undefined ? { notes } : {}),
    createdById: userId
  });

  res.status(201).json(newRate);
};

export const removeRate = async (req: AuthRequest, res: Response) => {
  const { rateId } = req.params;
  await SupplierService.removeNegotiatedRate(rateId as string);
  res.json({ success: true });
};

export const updateRate = async (req: AuthRequest, res: Response) => {
  const { rateId } = req.params;
  const data = req.body;
  const updated = await SupplierService.updateNegotiatedRate(rateId as string, data);
  res.json(updated);
};
export const listProductAliases = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const aliases = await SupplierService.listProductAliases(id as string);
  res.json(aliases);
};

export const addProductAlias = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { aliasText, productName } = req.body;

  if (!aliasText || !productName) {
    return res.status(400).json({ error: 'aliasText and productName are required' });
  }

  try {
    const alias = await SupplierService.addProductAlias(
      id as string,
      aliasText,
      productName,
      req.user?.id
    );
    res.status(201).json(alias);
  } catch (err: any) {
    // A mapping to a product that has no rate is the caller's mistake, and the
    // message names it, so it must not be flattened into a 500.
    const status = Number(err?.status) || 500;
    res.status(status).json({ error: err?.message || 'Failed to add alias' });
  }
};

export const removeProductAlias = async (req: AuthRequest, res: Response) => {
  const { id, aliasId } = req.params;
  try {
    await SupplierService.removeProductAlias(id as string, aliasId as string);
    res.json({ success: true });
  } catch (err: any) {
    const status = Number(err?.status) || 500;
    res.status(status).json({ error: err?.message || 'Failed to remove alias' });
  }
};
