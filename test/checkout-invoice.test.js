const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const app = require('../server');
const config = require('../config');
const store = require('../lib/store');

function createDb() {
  return {
    products: [
      { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 500, stock: 10 },
      { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 1000, stock: 4 },
      { id: 3, sku: 'TEA', name: 'Tea', hsn: '0902', price: 125, stock: 8 }
    ],
    customers: [
      { id: 1, name: 'Test Customer', creditLimit: 5000, openingBalance: 50, totalBilled: 100, totalSettled: 25 }
    ],
    orders: [],
    auditLog: [],
    nextOrderId: 1001
  };
}

async function startApp(t, db) {
  t.mock.method(store, 'read', () => db);
  const write = t.mock.method(store, 'write', (updatedDb) => {
    assert.strictEqual(updatedDb, db);
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  });

  return { baseUrl: `http://127.0.0.1:${server.address().port}`, write };
}

function postJson(baseUrl, path, body) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('the printed invoice matches checkout with capped SAVE10 and mixed HSN GST', async (t) => {
  const db = createDb();
  const { baseUrl, write } = await startApp(t, db);
  const cart = { items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], coupon: ' save10 ' };
  const billed = { subtotal: 2000, discount: 150, tax: 157.25, total: 2007.25 };

  const previewResponse = await postJson(baseUrl, '/api/pricing/preview', cart);
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.couponStatus.code, 'SAVE10');
  assert.equal(preview.couponStatus.valid, true);
  const { lines, ...totals } = preview.totals;
  assert.deepEqual(totals, { ...billed, taxable: 1850, cgst: 78.63, sgst: 78.62 });
  assert.deepEqual(lines.map(({ gstPercent, tax }) => ({ gstPercent, tax })), [
    { gstPercent: 5, tax: 46.25 },
    { gstPercent: 12, tax: 111 }
  ]);
  assert.equal(write.mock.callCount(), 0);

  const checkoutResponse = await postJson(baseUrl, '/api/orders', {
    ...cart, customerId: 1, paymentMode: 'khata'
  });
  assert.equal(checkoutResponse.status, 201);
  const order = await checkoutResponse.json();
  const { subtotal, discount, tax, total } = order;
  assert.deepEqual({ subtotal, discount, tax, total }, billed);
  assert.equal(order.coupon, 'SAVE10');
  assert.deepEqual(order.items, [
    { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 500, qty: 2, gstRate: 0.05 },
    { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 1000, qty: 1, gstRate: 0.12 }
  ]);
  assert.equal(write.mock.callCount(), 1);
  assert.deepEqual(db.orders, [order]);
  assert.equal(db.customers[0].totalBilled, 2107.25);
  assert.equal(db.customers[0].balance, 2132.25);
  assert.deepEqual(db.products.map(({ stock }) => stock), [8, 3, 8]);

  const invoiceResponse = await fetch(`${baseUrl}/orders/${order.id}/invoice`);
  assert.equal(invoiceResponse.status, 200);
  const html = await invoiceResponse.text();
  const printedTotal = html.match(/>Invoice Total<\/td><td[^>]*>₹([\d.]+)<\/td>/);
  assert.equal(Number(printedTotal?.[1]), order.total, 'printed invoice total');
  const printedTax = html.match(/>CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹([\d.]+)<\/td>/);
  assert.equal(Number(printedTax?.[1]), order.tax, 'printed total GST');
  const rows = html.match(/<tr>.*?<\/tr>/g);
  assert.match(rows.find((row) => row.includes('<td>1006</td>')), />5%<\/td><td[^>]*>₹46\.25<\/td>/);
  assert.match(rows.find((row) => row.includes('<td>0405</td>')), />12%<\/td><td[^>]*>₹111\.00<\/td>/);
  assert.match(html, />Coupon Discount \(SAVE10\)<\/td><td[^>]*>-₹150\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  const riceRate = config.tax.hsnSlabs['1006'];
  t.after(() => { config.tax.hsnSlabs['1006'] = riceRate; });
  config.tax.hsnSlabs['1006'] = 18;
  const reprintResponse = await fetch(`${baseUrl}/orders/${order.id}/invoice`);
  assert.equal(reprintResponse.status, 200);
  assert.equal(await reprintResponse.text(), html);
});

test('checkout and the printed invoice agree for a single 18% item without a coupon', async (t) => {
  const { baseUrl } = await startApp(t, createDb());
  const checkoutResponse = await postJson(baseUrl, '/api/orders', { items: [{ id: 3, qty: 1 }] });
  assert.equal(checkoutResponse.status, 201);
  const { id, tax, total } = await checkoutResponse.json();
  assert.deepEqual({ tax, total }, { tax: 22.5, total: 147.5 });

  const invoiceResponse = await fetch(`${baseUrl}/orders/${id}/invoice`);
  assert.equal(invoiceResponse.status, 200);
  const html = await invoiceResponse.text();
  assert.match(html, />CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹22\.50<\/td>/);
  assert.match(html, />Invoice Total<\/td><td[^>]*>₹147\.50<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('a coupon below its minimum leaves preview totals undiscounted and checkout rejects it', async (t) => {
  const db = createDb();
  const originalDb = structuredClone(db);
  const { baseUrl, write } = await startApp(t, db);
  const cart = { items: [{ id: 3, qty: 1 }], coupon: ' flat50 ' };
  const error = 'Coupon FLAT50 requires a minimum order subtotal of ₹300';

  const previewResponse = await postJson(baseUrl, '/api/pricing/preview', cart);
  assert.equal(previewResponse.status, 200);
  const { couponStatus, totals } = await previewResponse.json();
  assert.deepEqual(couponStatus, { valid: false, error });
  assert.equal(totals.discount, 0);
  assert.equal(totals.tax, 22.5);
  assert.equal(totals.total, 147.5);

  const checkoutResponse = await postJson(baseUrl, '/api/orders', cart);
  assert.equal(checkoutResponse.status, 400);
  assert.deepEqual(await checkoutResponse.json(), { error });
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(db, originalDb);
});
