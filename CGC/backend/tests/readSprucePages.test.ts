import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SprucePdfError, type PdfTextPage } from '../src/lib/pdf/pdfWords.js';
import {
  aiFailureReason,
  layoutChanged,
  parseSprucePages,
  readSprucePages,
  type ReadOptions,
} from '../src/modules/orders/spruce/parseSprucePdf.js';
import type { ParsedSpruceReport, SpruceReportType } from '../src/modules/orders/spruce/spruceReportTypes.js';
import { deliveryReport, itemTrackingWideReport, page, run } from './fixtures/spruceLayouts.js';

/**
 * Which reader's reading is imported, and what the AI's double-check says,
 * in every case the import meets. The AI is a stand-in here: what it is given
 * and what it answers are under the test's control.
 */

const buffer = Buffer.from('pdf');

/** The layout reader's own reading of the synthetic delivery report. */
const layoutReading = () => parseSprucePages(deliveryReport());

/** An AI that reads exactly what the layout reader read, optionally changed. */
function aiReading(change: (report: ParsedSpruceReport) => ParsedSpruceReport = report => report) {
  const calls: Array<SpruceReportType | null> = [];
  const readWithAi = async (_buffer: Buffer, _pages: PdfTextPage[], type: SpruceReportType | null) => {
    calls.push(type);
    return change({ ...layoutReading(), readBy: 'AI' });
  };
  return { calls, readWithAi };
}

const read = (pages: PdfTextPage[], options: ReadOptions) => readSprucePages(buffer, pages, options);

describe('readSprucePages, both readers (the default)', () => {
  it('imports the layout reader\'s reading and says the AI agreed', async () => {
    const ai = aiReading();
    const report = await read(deliveryReport(), { mode: 'both', aiCheck: 'await', readWithAi: ai.readWithAi });

    assert.equal(report.readBy, 'PARSER');
    assert.deepEqual(report.rows, layoutReading().rows);
    assert.deepEqual(report.aiCheck, { status: 'agreed', compared: 5, agreed: 5, differences: [] });
    assert.deepEqual(ai.calls, ['DELIVERY']);
  });

  it('names the order where the readings differ, and still imports the layout reader\'s reading', async () => {
    const ai = aiReading(report => ({
      ...report,
      rows: report.rows.map(row => (row.documentNumber === '2608-700001' ? { ...row, customerName: 'U/M' } : row)),
    }));

    const report = await read(deliveryReport(), { mode: 'both', aiCheck: 'await', readWithAi: ai.readWithAi });

    assert.equal(report.aiCheck?.status, 'differences');
    assert.deepEqual(report.aiCheck?.differences, [
      { documentNumber: '2608-700001', detail: 'customer read as "Priya Raman" by the report reader, "U/M" by AI' },
    ]);
    assert.deepEqual(report.rows, layoutReading().rows, 'the layout reader\'s reading is the one imported');
  });

  it('only starts the AI for the preview, and does not wait for it', async () => {
    let started = 0;
    const never = new Promise<ParsedSpruceReport>(() => undefined);
    const report = await read(deliveryReport(), {
      mode: 'both',
      aiCheck: 'start',
      readWithAi: () => { started++; return never; },
    });

    assert.equal(started, 1);
    assert.equal(report.readBy, 'PARSER');
    assert.equal(report.aiCheck, undefined);
  });

  it('imports the layout reader\'s reading, and says so, when the AI cannot be reached', async () => {
    const report = await read(deliveryReport(), {
      mode: 'both',
      aiCheck: 'await',
      readWithAi: async () => { throw new Error('OpenAI request failed (503)'); },
    });

    assert.deepEqual(report.rows, layoutReading().rows);
    assert.deepEqual(report.aiCheck, {
      status: 'unavailable', compared: 0, agreed: 0, differences: [], reason: 'the AI could not be reached',
    });
  });

  it('does not hold the import past the wait', async () => {
    const started = Date.now();
    const report = await read(deliveryReport(), {
      mode: 'both',
      aiCheck: 'await',
      aiCheckTimeoutMs: 50,
      readWithAi: () => new Promise<ParsedSpruceReport>(() => undefined),
    });

    assert.ok(Date.now() - started < 2000);
    assert.equal(report.aiCheck?.status, 'unavailable');
    assert.equal(report.aiCheck?.reason, 'the AI gave no answer within 0 seconds');
  });

  it('lets the AI read alone where the layout reader cannot read the report', async () => {
    // The 21/10/2026 Custom Report: a layout whose headings the reader does not know.
    const unknownLayout = [page(0, [run(1.1, 2.5, 'Sales Order Item Tracking'), run(1.2, 5.7, 'Something New')])];
    assert.throws(() => parseSprucePages(unknownLayout), SprucePdfError);

    const ai = aiReading(report => ({ ...report, type: 'ITEM_TRACKING' }));
    const report = await read(unknownLayout, { mode: 'both', aiCheck: 'await', readWithAi: ai.readWithAi });

    assert.equal(report.readBy, 'AI');
    assert.equal(report.readByAiBecause, 'its layout was not recognised');
    assert.equal(report.rows.length, 5);
    assert.deepEqual(ai.calls, ['ITEM_TRACKING']);
  });

  it('keeps the layout reader\'s error where the AI cannot read the report either', async () => {
    const unknownLayout = [page(0, [run(1.1, 2.5, 'Sales Order Item Tracking'), run(1.2, 5.7, 'Something New')])];

    await assert.rejects(
      read(unknownLayout, { mode: 'both', aiCheck: 'await', readWithAi: async () => { throw new Error('down'); } }),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'MISSING_HEADERS'
    );
  });

  it('runs no double-check where none is asked for: a single report\'s import, the PO merge', async () => {
    const ai = aiReading();
    const report = await read(deliveryReport(), { mode: 'both', readWithAi: ai.readWithAi });

    assert.equal(report.aiCheck, undefined);
    assert.deepEqual(ai.calls, []);
  });
});

describe('readSprucePages, when the layout has changed under the layout reader', () => {
  // Three orders: 2610-700101, 2610-700102, 2610-700103.
  const pages = itemTrackingWideReport;
  const renamed = (documentNumbers: string[]) => async () => {
    const report = parseSprucePages(pages());
    return {
      ...report,
      readBy: 'AI' as const,
      rows: report.rows.map(row => (documentNumbers.includes(row.documentNumber) ? { ...row, customerName: `${row.customerName} (AI)` } : row)),
    };
  };

  it("imports the AI's reading where the readings differ on most orders, and says why", async () => {
    // As the 21/10/2026 Deliveries report: every customer read differently.
    const report = await read(pages(), {
      mode: 'both', aiCheck: 'await', readWithAi: renamed(['2610-700101', '2610-700102', '2610-700103']),
    });

    assert.equal(report.readBy, 'AI');
    assert.equal(report.readByAiBecause, "it and the report reader differ on 3 of its 3 orders, which means Spruce has changed the report's layout");
    assert.ok(report.rows.every(row => row.customerName.endsWith('(AI)')));
    assert.equal(report.aiCheck?.differences.length, 3, 'still flagged, order by order');
  });

  it("keeps the layout reader's reading where the AI differs on an order or two", async () => {
    const report = await read(pages(), { mode: 'both', aiCheck: 'await', readWithAi: renamed(['2610-700102']) });

    assert.equal(report.readBy, 'PARSER');
    assert.equal(report.rows.find(row => row.documentNumber === '2610-700102')?.customerName, 'Harrowgate Masonry');
    assert.equal(report.aiCheck?.status, 'differences');
  });

  it('draws the line at three orders and three in ten', () => {
    assert.equal(layoutChanged(17, 17), true);
    assert.equal(layoutChanged(3, 10), true);
    assert.equal(layoutChanged(8, 38), false, "luna's worst misreading on a known layout");
    assert.equal(layoutChanged(2, 2), false, 'too few orders to tell');
  });
});

describe('aiFailureReason', () => {
  it('says who can fix it', () => {
    assert.equal(aiFailureReason(new Error('OpenAI request failed (429): You have no credits remaining.')), 'the AI account is out of credit');
    assert.equal(aiFailureReason(new Error('OpenAI request failed (401): Incorrect API key provided')), 'the AI key was refused');
    assert.equal(aiFailureReason(new Error('OpenAI request failed: fetch failed')), 'the AI could not be reached');
  });
});

describe('readSprucePages, the other modes', () => {
  it('parser: never asks the AI', async () => {
    const ai = aiReading();
    const report = await read(deliveryReport(), { mode: 'parser', aiCheck: 'await', readWithAi: ai.readWithAi });

    assert.equal(report.readBy, 'PARSER');
    assert.deepEqual(ai.calls, []);
  });

  it('ai (the default): the AI reads it, and that is no news', async () => {
    const ai = aiReading();
    const report = await read(deliveryReport(), { mode: 'ai', readWithAi: ai.readWithAi });

    assert.equal(report.readBy, 'AI');
    assert.equal(report.readByAiBecause, undefined);
    assert.equal(report.aiFailed, undefined);
    assert.equal(report.pageCount, 2);
    assert.deepEqual(ai.calls, ['DELIVERY']);
  });

  it('ai: the layout reader reads it where the AI is out of credit, and says why', async () => {
    const report = await read(deliveryReport(), {
      mode: 'ai',
      readWithAi: async () => { throw new Error('OpenAI request failed (429): You have no credits remaining.'); },
    });

    assert.equal(report.readBy, 'PARSER');
    assert.equal(report.aiFailed, 'the AI account is out of credit');
    assert.deepEqual(report.rows, layoutReading().rows);
  });

  it('ai: the layout reader reads it where the AI is too slow', async () => {
    const report = await read(deliveryReport(), {
      mode: 'ai',
      aiCheckTimeoutMs: 50,
      readWithAi: () => new Promise<ParsedSpruceReport>(() => undefined),
    });

    assert.equal(report.readBy, 'PARSER');
    assert.equal(report.aiFailed, 'it gave no answer within 0 seconds');
  });

  it('ai: a file that is not a Spruce report is refused, whoever says so', async () => {
    const invoice = [page(0, [run(1, 1, 'Supplier Invoice'), run(1, 2, 'Amount Due')])];

    await assert.rejects(
      read(invoice, { mode: 'ai', readWithAi: async () => { throw new SprucePdfError('UNKNOWN_REPORT', 'not a Spruce report'); } }),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'UNKNOWN_REPORT'
    );
    // The AI down too: the layout reader's own refusal.
    await assert.rejects(
      read(invoice, { mode: 'ai', readWithAi: async () => { throw new Error('OpenAI request failed (503)'); } }),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'UNKNOWN_REPORT'
    );
  });

  it('auto: the layout reader, with no double-check', async () => {
    const ai = aiReading();
    const report = await read(deliveryReport(), { mode: 'auto', aiCheck: 'await', readWithAi: ai.readWithAi });

    assert.equal(report.readBy, 'PARSER');
    assert.equal(report.aiCheck, undefined);
    assert.deepEqual(ai.calls, []);
  });
});
