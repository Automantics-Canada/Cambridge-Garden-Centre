/**
 * Reading a delivery ticket.
 *
 * AWS Textract DetectDocumentText does the OCR, unchanged. What follows it is a
 * deterministic parser over that text rather than an unconditional call to a
 * language model, and the fallback reader is reached for only when a required
 * field is missing or was read with low confidence.
 *
 * The loose sanitisers this used to need — the code that coped with the model
 * returning an array where a number was expected, or an object where a string
 * was — are gone. There is one result type and everything is validated into it.
 */

import {
  TextractClient,
  DetectDocumentTextCommand,
} from '@aws-sdk/client-textract';
import path from 'node:path';
import fs from 'node:fs';
import {
  downloadStoredFileToTemp,
  cleanupTempFile,
  isStoredFileLocation,
  getFilenameFromUrl,
} from './urlHandler.js';
import { pdfToPng } from 'pdf-to-png-converter';
import { extractTicketFromText } from './documentExtraction/ticketExtractor.js';
import { finaliseTicketExtraction } from './documentExtraction/mergeExtraction.js';
import { fromTextractConfidence } from './documentExtraction/types.js';
import type { ExtractionOutcome, TicketExtraction } from './documentExtraction/types.js';

const textractClient = new TextractClient(); // Standard AWS credential provider chain

export type TicketOcrOutcome = ExtractionOutcome<TicketExtraction>;

export interface TicketOcrInput {
  imageUrl: string;
  jobId: string;
}

export async function extractTicketDocument({
  imageUrl,
  jobId,
}: TicketOcrInput): Promise<TicketOcrOutcome> {
  let localPath = imageUrl;
  let tempFile: string | null = null;
  let generatedImagePath: string | null = null;

  try {
    if (isStoredFileLocation(imageUrl)) {
      const filename = getFilenameFromUrl(imageUrl);
      tempFile = await downloadStoredFileToTemp(imageUrl, filename);
      localPath = tempFile;
    } else if (imageUrl.startsWith('/uploads/')) {
      const uploadsRoot = path.resolve(process.cwd(), 'uploads');
      const requestedPath = path.resolve(process.cwd(), `.${imageUrl}`);
      if (!requestedPath.startsWith(`${uploadsRoot}${path.sep}`)) {
        throw new Error('Invalid legacy upload path');
      }
      localPath = requestedPath;
    } else {
      throw new Error('Unsupported OCR file location');
    }

    if (!fs.existsSync(localPath)) {
      throw new Error('Ticket file not found for OCR');
    }

    const ext = path.extname(localPath).toLowerCase();
    let imagePathForOcr = localPath;

    if (ext === '.pdf') {
      const pages = await pdfToPng(fs.readFileSync(localPath), {
        viewportScale: 3,
        pagesToProcess: [1],
        disableFontFace: false,
        useSystemFonts: true,
        enableXfa: true,
      });
      const imageBuffer = pages[0]?.content;
      if (!imageBuffer) throw new Error('PDF did not render a first page');

      generatedImagePath = path.join(
        path.dirname(localPath),
        `${path.basename(localPath, ext)}-1.png`
      );
      fs.writeFileSync(generatedImagePath, Buffer.from(imageBuffer));
      imagePathForOcr = generatedImagePath;
    }

    return await readTicket(imagePathForOcr, jobId);
  } finally {
    if (generatedImagePath && fs.existsSync(generatedImagePath)) {
      try {
        fs.unlinkSync(generatedImagePath);
      } catch (error) {
        console.error('[OCR] Failed to clean up converted page image');
      }
    }
    if (tempFile) await cleanupTempFile(tempFile);
  }
}

async function readTicket(localPath: string, jobId: string): Promise<TicketOcrOutcome> {
  const result = await textractClient.send(
    new DetectDocumentTextCommand({ Document: { Bytes: fs.readFileSync(localPath) } })
  );

  const blocks = result.Blocks ?? [];
  const lineBlocks = blocks.filter(block => block.BlockType === 'LINE' && block.Text);

  if (lineBlocks.length === 0) {
    throw new Error('Textract detected no text in the ticket image');
  }

  const ocrText = lineBlocks.map(block => block.Text as string).join('\n');
  const ocrConfidence = fromTextractConfidence(
    lineBlocks.reduce((sum, block) => sum + (block.Confidence ?? 0), 0) / lineBlocks.length
  );

  const extraction = extractTicketFromText({ ocrText });

  return finaliseTicketExtraction({
    extraction,
    ocrText,
    ocrConfidence,
    documentType: 'TICKET',
    jobId,
  });
}
