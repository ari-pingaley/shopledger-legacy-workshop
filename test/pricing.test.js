const assert = require('node:assert/strict');
const test = require('node:test');
const pricing = require('../lib/pricing');
const tax = require('../lib/tax');

test('checkout apportions a normalized and capped coupon across the 5%, 12% and 18% GST slabs', () => {
  const items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 250, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 500, qty: 2 },
    { id: 3, name: 'Tea', hsn: '0902', price: 750, qty: 2 }
  ];

  assert.deepEqual(pricing.computeTotals(items, '  sAvE10  '), {
    subtotal: 3000,
    discount: 150,
    taxable: 2850,
    tax: 394.25,
    cgst: 197.13,
    sgst: 197.12,
    total: 3244.25,
    lines: [
      {
        id: 1, name: 'Rice', hsn: '1006', gstPercent: 5,
        gross: 500, discount: 25, taxable: 475, tax: 23.75, net: 498.75
      },
      {
        id: 2, name: 'Ghee', hsn: '0405', gstPercent: 12,
        gross: 1000, discount: 50, taxable: 950, tax: 114, net: 1064
      },
      {
        id: 3, name: 'Tea', hsn: '0902', gstPercent: 18,
        gross: 1500, discount: 75, taxable: 1425, tax: 256.50, net: 1681.50
      }
    ]
  });
});

test('GST calculation accepts explicit numeric percentages and decimals ahead of HSN', () => {
  assert.equal(tax.getRateForItem({ hsn: '1006', gstRate: 12 }), 0.12);
  assert.equal(tax.getRateForItem({ hsn: '0405', gstRate: 0.05 }), 0.05);
  assert.equal(tax.getRateForItem({ hsn: '0902', gstRate: 0 }), 0);
  assert.equal(tax.getRateForItem({}), 0.18);
});

test('CURRENT BEHAVIOUR: GST treats a numeric rate of 1 as 100% and ignores numeric strings', () => {
  assert.equal(tax.getSlabPercent({ hsn: '1006', gstRate: 1 }), 100);
  assert.equal(tax.getSlabPercent({ hsn: '0405', gstRate: '5' }), 12);
});

test('CURRENT BEHAVIOUR: GST falls back to 18% when a longer HSN starts with a configured code', () => {
  assert.equal(tax.getSlabPercent({ hsn: '1006' }), 5);
  assert.equal(tax.getSlabPercent({ hsn: '100610' }), 18);
});

test('CURRENT BEHAVIOUR: rounded line nets can sum to one paisa less than the checkout total', () => {
  const items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 10.10, qty: 1 },
    { id: 2, name: 'Dal', hsn: '0713', price: 10.10, qty: 1 }
  ];

  const totals = pricing.computeTotals(items, 'WELCOME');
  const lineAmounts = totals.lines.map(({ discount, taxable, tax, net }) => ({ discount, taxable, tax, net }));

  assert.equal(totals.subtotal, 20.20);
  assert.equal(totals.discount, 1.01);
  assert.equal(totals.taxable, 19.19);
  assert.equal(totals.tax, 0.96);
  assert.equal(totals.total, 20.15);
  assert.deepEqual(lineAmounts, [
    { discount: 0.51, taxable: 9.59, tax: 0.48, net: 10.07 },
    { discount: 0.51, taxable: 9.59, tax: 0.48, net: 10.07 }
  ]);
});
