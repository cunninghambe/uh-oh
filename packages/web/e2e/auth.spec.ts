import { expect, test } from '@playwright/test';

import { E2E_WRONG_PASSWORD } from './constants.js';
import { login } from './helpers.js';

test.describe('auth', () => {
  test('a wrong password shows an error and stays on the login page', async ({ page }) => {
    await login(page, E2E_WRONG_PASSWORD);

    await expect(page.getByRole('alert')).toHaveText('Invalid password.');
    await expect(page).toHaveURL(/\/login/);
  });

  // Deliberately calls `login` (the real form-fill-and-submit flow) directly rather than
  // helpers.ts's `loginAndLandOnProjects` — this is the one test whose job is to prove that
  // flow itself redirects correctly, so it must not go through that helper's cached-token
  // shortcut (see its doc comment: every other spec just needs to *be* logged in, this one is
  // testing *logging in*).
  test('b a correct login lands on the projects page', async ({ page }) => {
    await login(page);

    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page).toHaveURL('/');
  });
});
