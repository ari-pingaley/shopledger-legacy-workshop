const assert = require('node:assert/strict');
const test = require('node:test');
const invoice = require('../lib/invoice');
const reports = require('../lib/reports');

function makeItem(overrides) {
  return { name: 'Rice', hsn: '1006', price: 100, qty: 1, ...overrides };
}

function makeOrder(overrides) {
  return {
    id: 1,
    date: '2024-01-15',
    subtotal: 100,
    discount: 0,
    tax: 18,
    total: 118,
    items: [makeItem({ gstRate: 18 })],
    ...overrides
  };
}

test('invoice uses a saved whole-percent GST rate', () => {
  const items = [makeItem({ gstRate: 5 })];
  const figures = invoice.computeInvoiceFigures({ items });

  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.rows[0].lineTax, 5);
  assert.equal(figures.tax, 5);
  assert.equal(figures.cgst, 2.5);
  assert.equal(figures.sgst, 2.5);
  assert.equal(figures.total, 105);
});

test('invoice displays a decimal GST rate of 0.05 as 5% and computes ₹5 GST on ₹100', () => {
  const items = [makeItem({ gstRate: 0.05 })];
  const figures = invoice.computeInvoiceFigures({ items });

  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.rows[0].lineTax, 5);
  assert.equal(figures.tax, 5);
  assert.equal(figures.cgst, 2.5);
  assert.equal(figures.sgst, 2.5);
  assert.equal(figures.total, 105);
});

test('invoice preserves a saved zero GST rate', () => {
  const items = [makeItem({ gstRate: 0 })];
  const figures = invoice.computeInvoiceFigures({ items });

  assert.equal(figures.rows[0].gstPercent, 0);
  assert.equal(figures.rows[0].lineTax, 0);
  assert.equal(figures.tax, 0);
  assert.equal(figures.total, 100);
});

test('invoice totals the rounded GST amounts shown on each line', () => {
  const items = [
    makeItem({ price: 0.10, gstRate: 5 }),
    makeItem({ name: 'Dal', hsn: '0713', price: 0.10, gstRate: 5 })
  ];
  const figures = invoice.computeInvoiceFigures({ items });

  assert.deepEqual(figures.rows.map((row) => row.lineTax), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.equal(figures.cgst, 0.01);
  assert.equal(figures.sgst, 0.01);
  assert.equal(figures.total, 0.22);
});

test('invoice skips FLAT50 below its minimum subtotal', () => {
  const coupon = 'FLAT50';
  const items = [makeItem({ price: 40, gstRate: 18 })];
  const figures = invoice.computeInvoiceFigures({ items, coupon });

  assert.equal(figures.discount, 0);
  assert.equal(figures.tax, 7.20);
  assert.equal(figures.total, 47.20);
});

test('invoice skips an inactive coupon listed on an order', () => {
  const coupon = 'DIWALI20';
  const items = [makeItem({ price: 1000, gstRate: 18 })];
  const figures = invoice.computeInvoiceFigures({ items, coupon });

  assert.equal(figures.discount, 0);
  assert.equal(figures.tax, 180);
  assert.equal(figures.total, 1180);
});

test('invoice preserves the billed discount when a coupon has since expired', () => {
  const order = makeOrder({
    coupon: 'DIWALI20', subtotal: 1000, discount: 200, tax: 144, total: 944,
    items: [makeItem({ price: 1000, gstRate: 18 })]
  });
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.discount, 200);
  assert.equal(figures.rows[0].lineTax, 144);
  assert.equal(figures.tax, 144);
  assert.equal(figures.total, 944);
});

test('invoice applies a lowercase coupon code after normalization', () => {
  const coupon = 'welcome';
  const items = [makeItem({ price: 1000, gstRate: 18 })];
  const figures = invoice.computeInvoiceFigures({ items, coupon });

  assert.equal(figures.discount, 50);
  assert.equal(figures.tax, 171);
  assert.equal(figures.total, 1121);
});

test('invoice preserves the 18% GST billed before the HSN pricing migration', () => {
  const order = makeOrder({
    subtotal: 640, tax: 115.20, total: 755.20, items: [makeItem({ price: 640 })]
  });
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.total, 755.20);
  assert.equal(figures.tax, 115.20);
  assert.equal(figures.rows[0].gstPercent, 18);
  assert.equal(figures.rows[0].lineTax, 115.20);
});

test('invoice recognizes old flat GST when the saved subtotal has floating point residue', () => {
  const items = Array.from({ length: 3 }, () => makeItem({ price: 10.20 }));
  const order = makeOrder({ subtotal: 30.599999999999998, tax: 5.51, total: 36.11, items });
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.tax, 5.51);
  assert.deepEqual(figures.rows.map((row) => [row.gstPercent, row.lineTax]), [[18, 1.84], [18, 1.83], [18, 1.84]]);
});

test('invoice uses the full saved discount when reconstructing flat GST', () => {
  const order = makeOrder({
    coupon: 'SAVE10', subtotal: 600.28, discount: 60.028, tax: 97.25, total: 637.50,
    items: [makeItem({ price: 600.28 })]
  });
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.discount, 60.03);
  assert.equal(figures.rows[0].lineTax, 97.25);
  assert.equal(figures.rows[0].gstPercent, 18);
});

test('invoice flags unavailable line GST when two pricing methods match the saved GST', () => {
  const items = Array.from({ length: 12 }, () => makeItem({ hsn: '0902', price: 10.25 }));
  items.push(makeItem({ hsn: '0405', price: 1 }));
  const order = makeOrder({ subtotal: 124, tax: 22.32, total: 146.32, items });
  const html = invoice.render(order);

  assert.match(html, />CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹22\.32<\/td>/);
  assert.match(html, /Per-line GST is unavailable for this saved order/);
});

test('invoice labels line GST reconstructed from orders with no saved rates', () => {
  const order = makeOrder({
    subtotal: 200, tax: 17, total: 217,
    items: [makeItem(), makeItem({ name: 'Ghee', hsn: '0405' })]
  });

  assert.match(invoice.render(order), /Line GST was reconstructed using the available pricing rules/);
});

test('invoice prints the billed summary when historical line GST cannot be recovered', () => {
  const order = makeOrder({ tax: 12, total: 112, items: [makeItem()] });
  const html = invoice.render(order);

  assert.match(html, />CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹12\.00<\/td>/);
  assert.match(html, />Invoice Total<\/td><td[^>]*>₹112\.00<\/td>/);
  assert.match(html, /<td class="r">-<\/td><td class="r">-<\/td>/);
  assert.match(html, /Per-line GST is unavailable for this saved order/);
  const reconciliation = reports.getGstReconciliation({ orders: [order] });
  assert.equal(reconciliation.mismatchCount, 1);
  assert.equal(reconciliation.rows[0].invoiceTax, 12);
  assert.equal(reconciliation.rows[0].invoiceTotal, 112);
  assert.equal(reconciliation.rows[0].recalculatedTax, 5);
  assert.equal(reconciliation.rows[0].recalculatedTotal, 105);
});

test('reconciliation matches GST on a discounted order with matching billed amounts', () => {
  const order = makeOrder({
    coupon: 'SAVE10',
    subtotal: 600,
    discount: 60,
    tax: 97.20,
    total: 637.20,
    items: [makeItem({ name: 'Tea', hsn: '0902', price: 600 })]
  });
  const reconciliation = reports.getGstReconciliation({ orders: [order] });

  assert.equal(reconciliation.totalChecked, 1);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].ledgerTax, 97.20);
  assert.equal(reconciliation.rows[0].invoiceTax, 97.20);
  assert.equal(reconciliation.rows[0].ledgerTotal, 637.20);
  assert.equal(reconciliation.rows[0].invoiceTotal, 637.20);
  assert.equal(reconciliation.rows[0].delta, 0);
  assert.equal(reconciliation.rows[0].matched, true);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('reconciliation reports signed row deltas and sums their absolute values, excluding cancelled orders', () => {
  const orders = [
    makeOrder({ id: 1, tax: 5, total: 105 }),
    makeOrder({ id: 2, tax: 25, total: 125 }),
    makeOrder({ id: 3 }),
    makeOrder({ id: 4, status: 'cancelled', tax: 5, total: 105 })
  ];
  const reconciliation = reports.getGstReconciliation({ orders });

  assert.equal(reconciliation.totalChecked, 3);
  assert.equal(reconciliation.mismatchCount, 2);
  assert.equal(reconciliation.totalDelta, 20);
  assert.deepEqual(reconciliation.rows.map(({ orderId, delta, matched }) => ({ orderId, delta, matched })), [
    { orderId: 1, delta: 13, matched: false },
    { orderId: 2, delta: -7, matched: false },
    { orderId: 3, delta: 0, matched: true }
  ]);
});
