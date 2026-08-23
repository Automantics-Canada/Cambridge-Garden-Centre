import { test, expect } from './fixtures.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  USERS,
  authHeaders,
  expectNoLoading,
  loginApi,
  loginInBrowser,
} from './helpers.js';

test.describe.configure({ mode: 'serial' });

test('anonymous redirect, invalid login, authenticated admin logout', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill('missing@example.test');
  await page.locator('#login-password').fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await page.getByLabel('Email').fill(USERS.admin.email);
  await page.locator('#login-password').fill(USERS.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: /Good to see you/i })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('ADMIN can render the complete desktop route matrix without fake totals', async ({ page }) => {
  await loginInBrowser(page, USERS.admin);
  await expect(page).toHaveURL(/\/dashboard$/);

  const routes = [
    ['/dashboard/orders', 'Orders'],
    ['/dashboard/invoices', 'Invoices'],
    ['/dashboard/tickets', 'Tickets'],
    ['/dashboard/supplier', 'Suppliers'],
    ['/dashboard/rates', 'Negotiated rates'],
    ['/dashboard/products', 'Products'],
    ['/dashboard/verification-desk', 'Verification desk'],
    ['/dashboard/drivers', 'Drivers'],
    ['/dashboard/dispatch', 'Dispatch board'],
    ['/dashboard/deliveries', 'Deliveries'],
  ];

  for (const [route, heading] of routes) {
    await page.goto(route);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expectNoLoading(page);
  }

  await page.goto('/dashboard/invoices');
  const reviewRow = page.getByRole('row').filter({ hasText: 'PENDING-QA-REVIEW' });
  await expect(reviewRow).toBeVisible();
  await expect(reviewRow).not.toContainText('$0.00');
  await expect(reviewRow).toContainText('—');
  await reviewRow.click();
  await expect(page.getByRole('heading', { name: /PENDING-QA-REVIEW/ })).toBeVisible();
  await expect(page.getByText('Pending extraction', { exact: true })).toBeVisible();
  await expect(page.getByText('$0.00', { exact: true })).toHaveCount(0);
});

test('AP browser access works and API role denials are enforced', async ({ page, api }) => {
  await loginInBrowser(page, USERS.ap);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('QA Accounts Payable')).toBeVisible();

  const { token: apToken } = await loginApi(api, USERS.ap);
  const createDriver = await api.post('/api/drivers', {
    headers: authHeaders(apToken),
    data: { name: 'Denied Driver', phone: '+15550009999' },
  });
  expect(createDriver.status()).toBe(403);

  const invalidDispatchDate = await api.get('/api/dispatch?date=not-a-date', {
    headers: authHeaders(apToken),
  });
  expect(invalidDispatchDate.status()).toBe(400);
});

test('API mutations persist and invoice status transitions round-trip', async ({ api }) => {
  const { token } = await loginApi(api, USERS.admin);
  const headers = authHeaders(token);
  const name = `QA Product ${Date.now()}`;

  const createdProductResponse = await api.post('/api/products', {
    headers,
    data: { name, unit: 'tonnes' },
  });
  expect(createdProductResponse.status()).toBe(201);
  const createdProduct = await createdProductResponse.json();

  let productsResponse = await api.get('/api/products', { headers });
  expect(productsResponse.status()).toBe(200);
  expect((await productsResponse.json()).some((product) => product.id === createdProduct.id)).toBe(true);

  const deleteProduct = await api.delete(`/api/products/${createdProduct.id}`, { headers });
  expect(deleteProduct.status()).toBe(200);
  productsResponse = await api.get('/api/products', { headers });
  expect((await productsResponse.json()).some((product) => product.id === createdProduct.id)).toBe(false);

  const invoicesResponse = await api.get('/api/invoices?page=1&limit=50', { headers });
  expect(invoicesResponse.status()).toBe(200);
  const invoices = await invoicesResponse.json();
  const invoice = invoices.data.find((item) => item.invoiceNumber === 'QA-INV-1001');
  const unknownTotal = invoices.data.find((item) => item.invoiceNumber === 'PENDING-QA-REVIEW');
  expect(invoice).toBeTruthy();
  expect(unknownTotal.totalAmount).toBeNull();

  const verifyResponse = await api.post(`/api/invoices/${invoice.id}/verify`, { headers });
  expect(verifyResponse.status()).toBe(200);
  let invoiceRead = await api.get(`/api/invoices/${invoice.id}`, { headers });
  expect((await invoiceRead.json()).status).toBe('VERIFIED');

  const disputeResponse = await api.post(`/api/invoices/${invoice.id}/dispute`, {
    headers,
    data: { note: 'Sanitized QA dispute' },
  });
  expect(disputeResponse.status()).toBe(200);
  invoiceRead = await api.get(`/api/invoices/${invoice.id}`, { headers });
  expect((await invoiceRead.json()).status).toBe('DISPUTED');

  const reopenResponse = await api.post(`/api/invoices/${invoice.id}/reopen`, {
    headers,
    data: { reason: 'Sanitized QA reopen' },
  });
  expect(reopenResponse.status()).toBe(200);
  invoiceRead = await api.get(`/api/invoices/${invoice.id}`, { headers });
  expect((await invoiceRead.json()).status).toBe('PENDING_REVIEW');
});

test('dispatch assignment/unassignment persists and reorder rejects unsafe input', async ({ api }) => {
  const { token } = await loginApi(api, USERS.admin);
  const headers = authHeaders(token);
  const boardResponse = await api.get('/api/dispatch?date=2026-08-23', { headers });
  expect(boardResponse.status()).toBe(200);
  const board = await boardResponse.json();
  const driver = board.drivers.find((item) => item.email === USERS.driver.email);
  const waiting = board.unassignedDeliveries.find((item) => item.order?.spruceOrderId === 'QA-260823-L2');
  expect(driver).toBeTruthy();
  expect(waiting).toBeTruthy();

  const assignResponse = await api.post('/api/dispatch/assign', {
    headers,
    data: { orderId: waiting.order.id, driverId: driver.id },
  });
  expect(assignResponse.status()).toBe(200);
  const assigned = await assignResponse.json();

  let deliveriesResponse = await api.get('/api/deliveries?page=1&limit=50', { headers });
  let deliveries = await deliveriesResponse.json();
  expect(deliveries.data.find((item) => item.id === assigned.id)?.driverId).toBe(driver.id);

  const unsafeReorder = await api.post('/api/dispatch/reorder', {
    headers,
    data: { driverId: driver.id, deliveryIds: ['00000000-0000-4000-8000-000000000000'] },
  });
  expect(unsafeReorder.status()).toBeGreaterThanOrEqual(400);

  const unassignResponse = await api.post('/api/dispatch/unassign', {
    headers,
    data: { orderId: waiting.order.id },
  });
  expect(unassignResponse.status()).toBe(200);
  deliveriesResponse = await api.get('/api/deliveries?page=1&limit=50', { headers });
  deliveries = await deliveriesResponse.json();
  const unassigned = deliveries.data.find((item) => item.id === assigned.id);
  expect(unassigned.driverId).toBeNull();
  expect(unassigned.status).toBe('UNASSIGNED');
});

test('upload validation rejects spoofed files and sanitized uploads persist only pending records', async ({ api }) => {
  const { token } = await loginApi(api, USERS.admin);
  const headers = authHeaders(token);
  const png = await fs.readFile(path.resolve('../backend/uploads/qa/ticket.png'));

  const invalid = await api.post('/api/tickets/upload', {
    headers,
    multipart: {
      file: { name: 'spoofed.png', mimeType: 'image/png', buffer: Buffer.from('not-an-image') },
    },
  });
  expect(invalid.status()).toBe(415);

  const ticketUpload = await api.post('/api/tickets/upload', {
    headers,
    multipart: {
      file: { name: 'sanitized-ticket.png', mimeType: 'image/png', buffer: png },
    },
  });
  expect(ticketUpload.status()).toBe(201);
  const uploaded = await ticketUpload.json();
  const persistedResponse = await api.get(`/api/tickets/${uploaded.ticket.id}`, { headers });
  expect(persistedResponse.status()).toBe(200);
  const persisted = await persistedResponse.json();
  expect(persisted.status).toBe('UNLINKED');
  expect(persisted.supplierId).toBeNull();
  expect(persisted.poNumber).toBeNull();
  expect(persisted.material).toBeNull();
  expect(persisted.quantity).toBeNull();
  const ticketJob = await api.get(`/api/tickets/${uploaded.ticket.id}/ocr-status`, { headers });
  expect(ticketJob.status()).toBe(200);
  expect((await ticketJob.json()).status).toBe('PENDING');

  const invoiceUpload = await api.post('/api/invoices/upload', {
    headers,
    multipart: {
      file: { name: 'sanitized-invoice.png', mimeType: 'image/png', buffer: png },
    },
  });
  expect(invoiceUpload.status()).toBe(202);
  const invoice = (await invoiceUpload.json()).invoice;
  const invoiceRead = await api.get(`/api/invoices/${invoice.id}`, { headers });
  const persistedInvoice = await invoiceRead.json();
  expect(persistedInvoice.totalAmount).toBeNull();
  expect(persistedInvoice.lineItems).toHaveLength(0);
});
