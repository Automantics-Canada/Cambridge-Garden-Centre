import { test, expect } from './fixtures.js';
import path from 'node:path';
import { USERS, authHeaders, loginApi, loginInBrowser } from './helpers.js';

test.describe.configure({ mode: 'serial' });

test('DRIVER is isolated to the mobile portal and may access only own records', async ({ page, api }) => {
  await loginInBrowser(page, USERS.driver, true);
  await expect(page).toHaveURL(/\/driver\/today$/);
  await expect(page.getByRole('heading', { name: 'CGC Logistics' })).toBeVisible();
  await expect(page.getByText('QA Driver')).toBeVisible();

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/driver\/today$/);

  const { token } = await loginApi(api, USERS.driver);
  const headers = authHeaders(token);

  // New emailed links carry the bearer in a fragment, which never reaches the
  // frontend server. The app exchanges it into tab storage and strips it before
  // rendering any operational data.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(`/driver/today#token=${token}`);
  await expect(page.getByRole('heading', { name: 'CGC Logistics' })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:5173/driver/today');

  expect((await api.get('/api/products', { headers })).status()).toBe(403);
  expect((await api.get('/api/invoices?page=1&limit=10', { headers })).status()).toBe(403);
  expect((await api.get('/api/drivers', { headers })).status()).toBe(403);

  const me = await (await api.get('/api/drivers/me', { headers })).json();
  expect((await api.get(`/api/drivers/${me.id}/deliveries`, { headers })).status()).toBe(403);

  // A DRIVER must not widen limit=1 into the rest of the route or act on a
  // later assigned stop. Create one with ADMIN, prove both denials, then clean
  // it up so the following delivery-flow test retains its single-stop fixture.
  const { token: adminToken } = await loginApi(api, USERS.admin);
  const adminHeaders = authHeaders(adminToken);
  const board = await (await api.get('/api/dispatch?date=2026-08-23', { headers: adminHeaders })).json();
  const waiting = board.unassignedDeliveries.find((item) => item.order?.spruceOrderId === 'QA-260823-L2');
  const assigned = await (await api.post('/api/dispatch/assign', {
    headers: adminHeaders,
    data: { orderId: waiting.order.id, driverId: me.id },
  })).json();
  try {
    const widened = await api.get('/api/deliveries?page=1&limit=100', { headers });
    expect(widened.status()).toBe(200);
    expect((await widened.json()).data).toHaveLength(1);

    const futureMutation = await api.patch(`/api/deliveries/${assigned.id}/status`, {
      headers,
      data: { status: 'IN_TRANSIT' },
    });
    expect(futureMutation.status()).toBe(403);
  } finally {
    await api.post('/api/dispatch/unassign', {
      headers: adminHeaders,
      data: { orderId: waiting.order.id },
    });
  }
});

test('driver delivery flow enforces proof, uploads it, completes, and persists history', async ({ page, api }) => {
  await loginInBrowser(page, USERS.driver, true);
  await expect(page.getByText('QA-260823-L1')).toBeVisible();

  const { token } = await loginApi(api, USERS.driver);
  const headers = authHeaders(token);
  const deliveriesResponse = await api.get('/api/deliveries', { headers });
  expect(deliveriesResponse.status()).toBe(200);
  const delivery = (await deliveriesResponse.json()).find((item) => item.order.spruceOrderId === 'QA-260823-L1');
  expect(delivery.status).toBe('PLACED');

  const prematureComplete = await api.patch(`/api/deliveries/${delivery.id}/status`, {
    headers,
    data: { status: 'DELIVERED' },
  });
  expect(prematureComplete.status()).toBe(409);

  await page.getByRole('button', { name: 'Confirm and start' }).click();
  await expect(page.getByText('Add a delivery photo to complete this stop.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete delivery' })).toBeDisabled();

  let persisted = await api.get('/api/deliveries', { headers });
  expect((await persisted.json()).find((item) => item.id === delivery.id).status).toBe('IN_TRANSIT');

  const deliveryPhoto = page.locator('label', { hasText: 'Delivery photo' }).locator('input[type=file]');
  await deliveryPhoto.setInputFiles(path.resolve('../backend/uploads/qa/delivery.png'));
  await expect(page.getByText('Proof ok')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete delivery' })).toBeEnabled();

  await page.getByRole('button', { name: 'Complete delivery' }).click();
  await expect(page.getByText('All done for now')).toBeVisible();

  persisted = await api.get('/api/deliveries', { headers });
  expect((await persisted.json()).some((item) => item.id === delivery.id)).toBe(false);

  // Completed history is deliberately no longer visible through DRIVER scope;
  // use an operations identity to verify the persisted mutation and evidence.
  const { token: adminToken } = await loginApi(api, USERS.admin);
  const adminHeaders = authHeaders(adminToken);
  const completedRows = await api.get('/api/deliveries?page=1&limit=50', { headers: adminHeaders });
  const completed = (await completedRows.json()).data.find((item) => item.id === delivery.id);
  expect(completed.status).toBe('DELIVERED');
  expect(completed.deliveryPhotoUrl).toContain('/uploads/deliveries/');
  expect(completed.history.some((entry) => entry.status === 'IN_TRANSIT')).toBe(true);
  expect(completed.history.some((entry) => entry.status === 'DELIVERED')).toBe(true);

  const terminalChange = await api.patch(`/api/deliveries/${delivery.id}/status`, {
    headers,
    data: { status: 'IN_TRANSIT' },
  });
  expect(terminalChange.status()).toBe(403);

  const operationsTerminalChange = await api.patch(`/api/deliveries/${delivery.id}/status`, {
    headers: adminHeaders,
    data: { status: 'IN_TRANSIT' },
  });
  expect(operationsTerminalChange.status()).toBe(409);
});
