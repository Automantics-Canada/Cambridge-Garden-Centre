import { test as base, expect } from '@playwright/test';

const safeTitle = (title) => title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

export const test = base.extend({
  api: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: 'http://127.0.0.1:4000',
    });
    await use(context);
    await context.dispose();
  },
  page: async ({ page }, use, testInfo) => {
    const consoleErrors = [];
    const failedRequests = [];
    const unexpectedResponses = [];
    const duplicateRequests = [];
    const activeRequests = new Map();

    page.on('console', (message) => {
      const expectedInvalidLoginNoise = message.text()
        === 'Failed to load resource: the server responded with a status of 401 (Unauthorized)';
      if (message.type() === 'error' && !expectedInvalidLoginNoise) consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('request', (request) => {
      if (!['fetch', 'xhr'].includes(request.resourceType())) return;
      const key = `${request.method()} ${request.url()}`;
      const active = activeRequests.get(key) || 0;
      if (active > 0) duplicateRequests.push(key);
      activeRequests.set(key, active + 1);
    });
    const finishRequest = (request) => {
      if (!['fetch', 'xhr'].includes(request.resourceType())) return;
      const key = `${request.method()} ${request.url()}`;
      const remaining = (activeRequests.get(key) || 1) - 1;
      if (remaining <= 0) activeRequests.delete(key);
      else activeRequests.set(key, remaining);
    };
    page.on('requestfinished', finishRequest);
    page.on('requestfailed', (request) => {
      finishRequest(request);
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on('response', (response) => {
      const expectedInvalidLogin = response.status() === 401
        && new URL(response.url()).pathname === '/api/auth/login';
      if (response.status() >= 400 && !expectedInvalidLogin) {
        unexpectedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      }
    });

    await use(page);

    await page.screenshot({
      path: testInfo.outputPath(`${safeTitle(testInfo.title)}.png`),
      fullPage: true,
    }).catch(() => {});

    expect(consoleErrors, 'browser console/page errors').toEqual([]);
    expect(failedRequests, 'failed browser requests').toEqual([]);
    expect(unexpectedResponses, 'unexpected browser 4xx/5xx responses').toEqual([]);
    expect(duplicateRequests, 'concurrent duplicate browser API requests').toEqual([]);
  },
});

export { expect } from '@playwright/test';
