import './setupEnv.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { layoutText, vetAnswer, type AnswerLine } from '../src/modules/orders/spruce/aiReadSpruceReport.js';
import { deliveryReport, page, run } from './fixtures/spruceLayouts.js';

/**
 * The checks every AI-read line must pass before it is imported. The model is
 * never called here: these are its answers, right and wrong, against the
 * synthetic delivery report (2608-700001: SOILSCRNA 4 CY, RSKID 2 EA;
 * 2608-700002: AGG01 40 MT, AGGSTNEDUSTA 1 CY, MISCDELI 1 EA).
 */

const line = (fields: Partial<AnswerLine>): AnswerLine => ({
  page: 1,
  documentNumber: '2608-700001',
  customerName: 'Priya Raman',
  product: 'Screened Soil Bulk',
  itemNumber: 'SOILSCRNA',
  quantity: 4,
  unit: 'CY',
  ...fields,
});

/** Every line of the fixture, read correctly. */
const correct = (): AnswerLine[] => [
  line({ deliveryDate: '09/02/26', phone: '519-555-0128', totalWithTax: 176.28, accountName: 'Cash Sales' }),
  line({ itemNumber: 'RSKID', product: 'Rinox Skid Deposit ($35 refundable upon return in good condition)', quantity: 2, unit: 'EA' }),
  line({ page: 2, documentNumber: '2608-700002', customerName: 'Harrowgate Masonry', itemNumber: 'AGG01', product: 'Agg "B" Type 1 PitBlk (MT)', quantity: 40, unit: 'MT', totalWithTax: 2149.57 }),
  line({ page: 2, documentNumber: '2608-700002', customerName: 'Harrowgate Masonry', itemNumber: 'AGGSTNEDUSTA', product: 'Agg Stone Dust YrdBlk 1CY', quantity: 1 }),
  line({ page: 2, documentNumber: '2608-700002', customerName: 'Harrowgate Masonry', itemNumber: 'MISCDELI', product: 'Splitbox Delivery', quantity: 1, unit: 'EA' }),
];

describe('vetAnswer: what an AI-read line must pass', () => {
  it('keeps a correct reading whole, thousands separators and wrapped descriptions included', () => {
    const { rows, unreadable } = vetAnswer('DELIVERY', correct(), deliveryReport());

    assert.deepEqual(unreadable, []);
    assert.equal(rows.length, 5);
    assert.equal(rows[0]?.deliveryDateRaw, '09/02/26');
    assert.equal(rows[2]?.totalWithTax, 2149.57);
    assert.equal(rows[1]?.product, 'Rinox Skid Deposit ($35 refundable upon return in good condition)');
  });

  it('refuses a value the report does not print', () => {
    const answer = correct();
    answer[0] = { ...answer[0]!, phone: '519-555-9999' };
    answer[2] = { ...answer[2]!, quantity: 44 };

    const { rows, unreadable } = vetAnswer('DELIVERY', answer, deliveryReport());

    assert.equal(rows.length, 3);
    assert.match(unreadable[0]!.reason, /phone "519-555-9999" is not printed/);
    assert.match(unreadable[1]!.reason, /quantity 44 is not printed/);
  });

  it('refuses a printed value in the wrong field: the document number as the delivery date', () => {
    const answer = correct();
    answer[0] = { ...answer[0]!, deliveryDate: '2608-700001' };

    const { unreadable } = vetAnswer('DELIVERY', answer, deliveryReport());

    assert.match(unreadable[0]!.reason, /"2608-700001" is not a deliveryDate/);
  });

  it('refuses a line put on the wrong order, though every value of it is printed', () => {
    // 2610-721465's three Permacon skids, moved onto 2610-721461 on 21/10/2026.
    const answer = correct();
    answer[2] = { ...answer[2]!, documentNumber: '2608-700001', customerName: 'Priya Raman' };

    const { rows, unreadable } = vetAnswer('DELIVERY', answer, deliveryReport());

    assert.equal(rows.length, 4);
    assert.match(unreadable[0]!.reason, /AGG01 x 40 is not printed under this order/);
  });

  it('reports an order the model left out entirely', () => {
    const { unreadable } = vetAnswer('DELIVERY', correct().slice(0, 2), deliveryReport());

    assert.deepEqual(unreadable.map(row => row.reason), [
      'Document 2608-700002 is in the report but the AI read no lines for it',
    ]);
  });

  it('reads a dash for the unit as no unit', () => {
    const answer = correct();
    answer[4] = { ...answer[4]!, unit: '-' };

    assert.equal(vetAnswer('DELIVERY', answer, deliveryReport()).rows[4]?.unit, undefined);
  });

  it('accepts a word the report wraps over two lines, joined up', () => {
    const pages = [page(0, [
      run(1.5, 8.7, '2608-700009'),
      run(21.4, 8.7, 'Salt Buyer'),
      run(4.5, 10.5, 'SALTCOMM'),
      run(12.4, 10.5, 'E-transfer to accounts@gardencentr'),
      run(29.1, 10.5, '1.0000'),
      run(12.4, 11.1, 'e.ca'),
    ])];
    const answer = [line({ documentNumber: '2608-700009', customerName: 'Salt Buyer', itemNumber: 'SALTCOMM', product: 'E-transfer to accounts@gardencentre.ca', quantity: 1, unit: null })];

    assert.deepEqual(vetAnswer('DELIVERY', answer, pages).unreadable, []);
  });
});

describe('layoutText', () => {
  it('lays each row out at its columns, page by page', () => {
    const text = layoutText(deliveryReport());

    assert.match(text, /^=== Page 1 ===/);
    assert.match(text, /=== Page 2 ===/);
    const soil = text.split('\n').find(row => row.includes('SOILSCRNA'))!;
    assert.ok(soil.indexOf('Screened Soil Bulk') > soil.indexOf('SOILSCRNA'));
    assert.ok(soil.indexOf('4.0000') > soil.indexOf('Screened Soil Bulk'));
  });
});
