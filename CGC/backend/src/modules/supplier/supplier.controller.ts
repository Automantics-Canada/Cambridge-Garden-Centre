import type { Response } from 'express';
import { SupplierService } from './supplier.service.js';
import type { AuthRequest } from '../../middleware/authMiddleware.js';
import { SupplierType } from '@prisma/client';
import { RateService } from './rates.service.js';
import { PriceListService, parseTonMeans } from './priceList.service.js';
import { scheduleRateRecheck } from './rateRecheck.js';
import { sanitizeFilename } from '../../middleware/uploadValidation.js';
import { normaliseSenderEntries } from '../../services/knownSenders.js';

export const listSuppliers = async (_req: AuthRequest, res: Response) => {
  const suppliers = await SupplierService.list();
  res.json(suppliers);
};

export const listSupplierOptions = async (_req: AuthRequest, res: Response) => {
  const suppliers = await SupplierService.listOptions();
  res.json(suppliers);
};

/**
 * The supplier's email senders from a request body, or the reason they are
 * refused. The form sends domains and full addresses in one box, so both lists
 * are sorted again here. A free-mail domain is refused outright: kept, it
 * would make every gmail.com (or hotmail.com…) sender this supplier.
 */
function senderFields(body: Record<string, unknown>):
  | { ok: true; emailDomains: string[]; emailAddresses: string[] }
  | { ok: false; error: string } {
  const asList = (value: unknown) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []);
  const entries = normaliseSenderEntries(asList(body.emailDomains), asList(body.emailAddresses));
  if (entries.freeMailDomains.length > 0) {
    const domain = entries.freeMailDomains[0];
    return {
      ok: false,
      error: `${domain} is shared by many senders, so it cannot identify a supplier. Enter the full address instead, e.g. name@${domain}.`,
    };
  }
  if (entries.invalid.length > 0) {
    return { ok: false, error: `Not an email domain or address: ${entries.invalid.join(', ')}` };
  }
  return { ok: true, emailDomains: entries.emailDomains, emailAddresses: entries.emailAddresses };
}

export const createSupplier = async (req: AuthRequest, res: Response) => {
  const { name, type, keywords, contactName, contactEmail, phone, address } =
    req.body;
  const senders = senderFields(req.body ?? {});
  if (!senders.ok) return res.status(400).json({ error: senders.error });

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
    emailDomains: senders.emailDomains,
    emailAddresses: senders.emailAddresses,
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
  const data = { ...(req.body ?? {}) };
  if ('emailDomains' in data || 'emailAddresses' in data) {
    const senders = senderFields(data);
    if (!senders.ok) return res.status(400).json({ error: senders.error });
    data.emailDomains = senders.emailDomains;
    // Only replaced when the request names the list, so an older client that
    // sends domains alone does not wipe the addresses.
    if ('emailAddresses' in data || senders.emailAddresses.length > 0) {
      data.emailAddresses = senders.emailAddresses;
    }
  }

  const supplier = await SupplierService.update(id as string, data);
  res.json(supplier);
};

export const deleteSupplier = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const supplier = await SupplierService.remove(id as string);
  res.json(supplier);
};

/**
 * Rates. The rules are in rates.service.ts; these only pass the request
 * through. A change to a supplier's rates re-checks its open invoices in the
 * background, so the person saving a rate does not wait for that.
 */
function requireUser(req: AuthRequest): string {
  const userId = req.user?.id;
  if (!userId) throw Object.assign(new Error('User ID missing in token'), { status: 401 });
  return userId;
}

export const addRate = async (req: AuthRequest, res: Response) => {
  const supplierId = req.params.id as string;
  const saved = await RateService.addRate(supplierId, req.body ?? {}, requireUser(req));
  if (saved.action !== 'UNCHANGED') scheduleRateRecheck(supplierId, 'Rate saved');
  res.status(saved.action === 'CREATE' || saved.action === 'SUPERSEDE' ? 201 : 200).json(saved);
};

export const updateRate = async (req: AuthRequest, res: Response) => {
  const supplierId = req.params.id as string;
  const updated = await RateService.updateRate(supplierId, req.params.rateId as string, req.body ?? {}, requireUser(req));
  scheduleRateRecheck(supplierId, 'Rate edited');
  res.json(updated);
};

export const expireRate = async (req: AuthRequest, res: Response) => {
  const supplierId = req.params.id as string;
  const expired = await RateService.expireRate(supplierId, req.params.rateId as string, req.body ?? {}, requireUser(req));
  scheduleRateRecheck(supplierId, 'Rate expired');
  res.json(expired);
};

export const removeRate = async (req: AuthRequest, res: Response) => {
  const supplierId = req.params.id as string;
  await RateService.removeRate(supplierId, req.params.rateId as string, requireUser(req));
  scheduleRateRecheck(supplierId, 'Rate deleted');
  res.json({ success: true });
};

function uploadedFile(req: AuthRequest) {
  const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
  if (!file) throw Object.assign(new Error('Choose a .csv or .xlsx file'), { status: 400 });
  return { buffer: file.buffer, originalname: sanitizeFilename(file.originalname) };
}

/** Sends a refusal that carries a fresh preview, so the page can show it. */
function sendPriceListError(res: Response, error: unknown) {
  const err = error as { status?: number; message?: string; preview?: unknown };
  if (err?.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message, ...(err.preview ? { preview: err.preview } : {}) });
  }
  throw error;
}

export const previewPriceListImport = async (req: AuthRequest, res: Response) => {
  try {
    const preview = await PriceListService.preview(
      req.params.id as string,
      uploadedFile(req),
      parseTonMeans(req.body?.tonMeans)
    );
    res.json(preview);
  } catch (error) {
    sendPriceListError(res, error);
  }
};

export const commitPriceListImport = async (req: AuthRequest, res: Response) => {
  const supplierId = req.params.id as string;
  try {
    const result = await PriceListService.commit(
      supplierId,
      uploadedFile(req),
      { token: String(req.body?.token ?? ''), tonMeans: parseTonMeans(req.body?.tonMeans) },
      requireUser(req)
    );
    scheduleRateRecheck(supplierId, 'Price list saved');
    res.json(result);
  } catch (error) {
    sendPriceListError(res, error);
  }
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
