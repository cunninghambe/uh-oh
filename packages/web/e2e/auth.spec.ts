import { expect, test } from '@playwright/test';

import { E2E_WRONG_PASSWORD } from './constants.js';
import { login, loginAndLandOnProjects } from './helpers.js';

test.describe('auth', () => {
  test('a wrong password shows an error and stays on the login page', async ({ page }) => {
    await login(page, E2E_WRONG_PASSWORD);

    await expect(page.getByRole('alert')).toHaveText('Invalid password.');
    await expect(page).toHaveURL(/\/login/);
  });

  test('b a correct login lands on the projects page', async ({ page }) => {
    await loginAndLandOnProjects(page);

    await expect(page).toHaveURL('/');
  });
});
