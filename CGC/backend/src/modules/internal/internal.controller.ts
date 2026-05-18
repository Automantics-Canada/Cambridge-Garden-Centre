import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { processOcrJob } from '../../services/ocrJobProcessor.js';

export const processOcrJobEndpoint = async (req: Request, res: Response) => {
  try {
    // Check for authorization header (Bearer token)
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
    
    // Check x-supabase-signature
    const signature = req.headers['x-supabase-signature'] as string | undefined;
    
    const expectedSecret = env.internalSharedSecret;
    
    if (token !== expectedSecret && signature !== expectedSecret) {
      console.warn(`[INTERNAL] Unauthorized access attempt to internal endpoint: signature=${signature}, token=${token ? '***' : 'none'}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const jobId = req.params.jobId;
    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'jobId is required and must be a string' });
    }

    console.log(`[INTERNAL] Triggered instant OCR processing for Job ID: ${jobId}`);
    
    // Process the job in a non-blocking background promise
    processOcrJob(jobId).catch((err) => {
      console.error(`[INTERNAL] Error processing OCR Job in background: ${jobId}`, err);
    });

    return res.status(202).json({
      success: true,
      message: `OCR job processing triggered for job ${jobId}`,
    });
  } catch (error: any) {
    console.error('[INTERNAL] Error in processOcrJobEndpoint:', error);
    return res.status(500).json({ error: error.message || 'Unexpected error' });
  }
};
