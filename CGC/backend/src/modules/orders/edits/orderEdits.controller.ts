import type { Response } from 'express';

import type { AuthRequest } from '../../../middleware/authMiddleware.js';
import { EditValidationError, parseEditRequest } from './editableFields.js';
import { OrderEditError, applyOrderEdits, getOrderForEditing, resetOrderEdit } from './orderEdits.service.js';

function sendEditError(res: Response, error: unknown) {
  if (error instanceof EditValidationError || error instanceof OrderEditError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('[OrderEdits] Failed', error);
  return res.status(500).json({ error: 'The change could not be saved. Nothing was changed; try again.' });
}

/** One order as the edit screen shows it, by id or by Spruce order number. */
export const getOrderEditor = async (req: AuthRequest, res: Response) => {
  try {
    return res.json(await getOrderForEditing(req.params.id as string));
  } catch (error) {
    return sendEditError(res, error);
  }
};

/** Saves a dispatcher's corrections and answers with the order as it now stands. */
export const editOrder = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const edits = parseEditRequest(req.body);
    const changes = await applyOrderEdits(id, edits, req.user!.id);
    return res.json({ changes, order: await getOrderForEditing(id) });
  } catch (error) {
    return sendEditError(res, error);
  }
};

/** Puts Spruce's value back for one field: `{ field, lineId? }`. */
export const resetOrderField = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { field, lineId } = req.body ?? {};
    if (typeof field !== 'string' || (lineId !== undefined && lineId !== null && typeof lineId !== 'string')) {
      return res.status(400).json({ error: 'Send the field to reset, and its line id for a line.' });
    }
    await resetOrderEdit(id, field, lineId ?? null, req.user!.id);
    return res.json({ order: await getOrderForEditing(id) });
  } catch (error) {
    return sendEditError(res, error);
  }
};
