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
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const product = await ProductService.create({ name });
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
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const product = await ProductService.update(id as string, { name });
    res.json(product);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Product name already exists' });
    }
    res.status(500).json({ error: error.message });
  }
};

export const deleteProduct = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    await ProductService.remove(id as string);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
