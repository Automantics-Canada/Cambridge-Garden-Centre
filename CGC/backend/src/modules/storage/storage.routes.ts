import { Router } from 'express';
import path from 'node:path';
import { downloadStorageObject } from '../../services/supabaseStorage.js';
import { verifySignedStorageRequest } from '../../services/storageAccess.js';

const router = Router();

router.get('/object/:reference/:filename', async (req, res) => {
  const location = verifySignedStorageRequest(
    req.params.reference,
    req.query.expires,
    req.query.signature,
  );
  if (!location) return res.status(403).json({ error: 'Invalid or expired document link' });
  if (req.params.filename !== path.posix.basename(location.path)) {
    return res.status(403).json({ error: 'Invalid document link' });
  }

  try {
    const object = await downloadStorageObject(location);
    res.setHeader('Content-Type', object.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', object.buffer.length.toString());
    res.setHeader('Cache-Control', 'private, max-age=60, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(object.buffer);
  } catch (error) {
    console.error('[Storage] Signed object read failed:', error instanceof Error ? error.message : String(error));
    return res.status(404).json({ error: 'Document not found' });
  }
});

export default router;
