import type { Response } from 'express';
import { ProductService } from './product.service.js';
import type { AuthRequest } from '../../middleware/authMiddleware.js';

export const listProducts = async (_req: AuthRequest, res: Response) => {
  try {
    const products = await ProductService.list();
    res.json(products);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createProduct = async (req: AuthRequest, res: Response) => {
  const { name, unit } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const product = await ProductService.create({ name, unit });
    res.status(201).json(product);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Product name already exists' });
    }
    res.status(500).json({ error: error.message });
  }
};

export const updateProduct = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { name, unit } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const product = await ProductService.update(id as string, { name, unit });
    res.json(product);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Product name already exists' });
    }
    res.status(500).json({ error: error.message });
  }
};

import { UnitService } from './unit.service.js';

export const deleteProduct = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    await ProductService.remove(id as string);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const listUnits = async (_req: AuthRequest, res: Response) => {
  try {
    const units = await UnitService.list();
    res.json(units);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const createUnit = async (req: AuthRequest, res: Response) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Unit name is required' });
  }

  try {
    const unit = await UnitService.create(name);
    res.status(201).json(unit);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Unit name already exists' });
    }
    res.status(500).json({ error: error.message });
  }
};

export const deleteUnit = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    await UnitService.remove(id as string);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
