import { describe, expect, it } from 'vitest';
import { describeFile, isPdfDocument, isSpreadsheetDocument } from './documentType';

describe('document types', () => {
  it('tells a spreadsheet from a PDF or an image by its path, not its query', () => {
    expect(isSpreadsheetDocument('https://storage.example/invoices/a/a-1.xlsx')).toBe(true);
    expect(isSpreadsheetDocument('/uploads/loads.CSV')).toBe(true);
    expect(isSpreadsheetDocument('/uploads/old.xls?x=1')).toBe(true);
    expect(isSpreadsheetDocument('/uploads/invoice.pdf?name=loads.xlsx')).toBe(false);
    expect(isSpreadsheetDocument('')).toBe(false);
    expect(isPdfDocument('/uploads/invoice.pdf')).toBe(true);
  });

  it('describes a file offered as a download', () => {
    expect(describeFile('loads.xlsx', 24_576)).toBe('loads.xlsx · 24 KB');
    expect(describeFile('big.csv', 2_400_000)).toBe('big.csv · 2.3 MB');
    expect(describeFile('', null)).toBe('File');
  });
});
