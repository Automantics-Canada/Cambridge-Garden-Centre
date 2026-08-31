import { expect } from '@playwright/test';

export const USERS = {
  admin: { email: 'admin.qa@example.test', password: 'QA-Admin-2026!' },
  ap: { email: 'ap.qa@example.test', password: 'QA-Ap-2026!' },
  driver: { email: 'driver.qa@example.test', password: 'QA-Driver-2026!' },
};

export async function loginInBrowser(page, user, driver = false) {
  await page.goto(driver ? '/login/driver' : '/login');
  await page.getByLabel('Email').fill(user.email);
  await page.locator('#login-password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function loginApi(request, user) {
  const response = await request.post('/api/auth/login', { data: user });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.token).toBeTruthy();
  return { token: body.token, user: body.user };
}

export const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

export async function expectNoLoading(page) {
  await expect(page.getByText(/Loading (view|Cambridge Garden Centre)/i)).toHaveCount(0, { timeout: 15_000 });
}
