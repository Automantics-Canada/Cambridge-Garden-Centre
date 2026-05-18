import { Router } from 'express';
import { processOcrJobEndpoint } from './internal.controller.js';

const router = Router();

router.post('/process-ocr/:jobId', processOcrJobEndpoint);

export default router;
