import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Output, Text } from 'pdf2json';

import {
  assertHasTextLayer,
  decodeRunText,
  normalisePages,
  SprucePdfError,
  type PdfTextPage,
} from '../src/lib/pdf/pdfWords.js';

/**
 * pdf2json only accepts PDFs written by a real PDF writer — it rejects both
 * pdf-lib output and a hand-assembled file, while reading genuine Spruce
 * exports (and those re-saved or page-split by pdf-lib) without complaint. So
 * these tests drive the mapping from pdf2json's output shape directly rather
 * than round-tripping a fixture PDF; the parse call itself is covered by
 * running the importer against the real reports.
 */

function text(x: number, y: number, parts: string[], fontSize = 13.7): Text {
  return {
    x,
    y,
    w: 10,
    sw: 1,
    A: 'left',
    R: parts.map(T => ({ T, S: -1, TS: [0, fontSize, 0, 0] as [number, number, 0 | 1, 0 | 1] })),
  };
}

function output(texts: Text[], width = 49.5, height = 38.25): Output {
  return {
    Transcoder: 'test',
    Meta: {},
    Pages: [
      { Width: width, Height: height, HLines: [], VLines: [], Fills: [], Texts: texts, Fields: [], Boxsets: [] },
    ],
  };
}

describe('decodeRunText', () => {
  it('decodes ordinary percent-encoded run text', () => {
    assert.equal(decodeRunText('Garden%20Soil%20Bulk'), 'Garden Soil Bulk');
  });

  it('keeps the text when the encoding is malformed rather than throwing', () => {
    // A lone '%' is what decodeURIComponent rejects; the real reports carry at
    // least one such run per page, and losing the row over it is not acceptable.
    assert.throws(() => decodeURIComponent('100% clear'), URIError);
    assert.equal(decodeRunText('100% clear'), '100% clear');
  });

  it('still decodes the well-formed escapes in a run that also has a bad one', () => {
    assert.equal(decodeRunText('Skid%20Deposit%20(%2435%) refundable'), 'Skid Deposit ($35%) refundable');
  });
});

describe('normalisePages', () => {
  it('joins a cell\'s styled fragments into one run and keeps its position', () => {
    const [page] = normalisePages(output([text(16.09, 7.48, ['Camden%20Step%20', 'Filler%20Granite%20Grey'])]));

    assert.equal(page?.runs.length, 1);
    assert.deepEqual(page?.runs[0], {
      text: 'Camden Step Filler Granite Grey',
      x: 16.09,
      y: 7.48,
      w: 10,
      fontSize: 13.7,
    });
  });

  it('carries page dimensions and a zero-based index', () => {
    const pages = normalisePages(output([text(1, 1, ['A'])]));

    assert.equal(pages[0]?.pageIndex, 0);
    assert.equal(pages[0]?.width, 49.5);
    assert.equal(pages[0]?.height, 38.25);
  });

  it('drops runs that are blank or whitespace only', () => {
    const pages = normalisePages(output([text(1, 1, ['%20%20']), text(2, 1, ['Real'])]));

    assert.deepEqual(pages[0]?.runs.map(r => r.text), ['Real']);
  });

  it('orders runs top to bottom, then left to right', () => {
    const pages = normalisePages(
      output([
        text(30.0, 9.29, ['second%20row%20right']),
        text(10.5, 9.29, ['second%20row%20left']),
        text(20.0, 6.58, ['first%20row']),
      ])
    );

    assert.deepEqual(pages[0]?.runs.map(r => r.text), [
      'first row',
      'second row left',
      'second row right',
    ]);
  });

  it('records the font size without letting a missing one throw', () => {
    const bare: Text = { x: 1, y: 1, w: 1, sw: 1, A: 'left', R: [{ T: 'x', S: -1 } as never] };

    assert.equal(normalisePages(output([bare]))[0]?.runs[0]?.fontSize, 0);
  });

  it('returns an entry per page even when a page holds no text', () => {
    const two = output([text(1, 1, ['A'])]);
    two.Pages.push({ Width: 49.5, Height: 38.25, HLines: [], VLines: [], Fills: [], Texts: [], Fields: [], Boxsets: [] });

    assert.deepEqual(normalisePages(two).map(p => p.runs.length), [1, 0]);
  });
});

describe('assertHasTextLayer', () => {
  const page = (runs: PdfTextPage['runs']): PdfTextPage => ({ pageIndex: 0, width: 49.5, height: 38.25, runs });

  it('rejects a document with no text, which is how a scan arrives', () => {
    assert.throws(
      () => assertHasTextLayer([page([])]),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'NO_TEXT_LAYER'
    );
  });

  it('rejects a document carrying only a letterhead', () => {
    assert.throws(
      () => assertHasTextLayer([page([{ text: 'CGC', x: 1, y: 1, w: 1, fontSize: 13.7 }])]),
      (err: unknown) => err instanceof SprucePdfError && err.code === 'NO_TEXT_LAYER'
    );
  });

  it('explains what to do rather than naming the internals', () => {
    try {
      assertHasTextLayer([page([])]);
      assert.fail('expected a SprucePdfError');
    } catch (err) {
      assert.match((err as Error).message, /Spruce/);
      assert.doesNotMatch((err as Error).message, /pdf2json|xref|buffer/i);
    }
  });

  it('accepts a document with a real report\'s worth of text', () => {
    const runs = ['2608-712589', 'Dutra Landscape', 'Garden Soil Bulk', '3.0000'].map((text, i) => ({
      text,
      x: i,
      y: 6.58,
      w: 5,
      fontSize: 13.7,
    }));

    assert.doesNotThrow(() => assertHasTextLayer([page(runs)]));
  });
});
