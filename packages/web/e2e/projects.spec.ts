import { expect, test } from '@playwright/test';

import { createProject, loginAndLandOnProjects, unique } from './helpers.js';

test.describe('projects', () => {
  test('c creating a project shows it in the list, including after a reload', async ({ page }) => {
    await loginAndLandOnProjects(page);

    const name = unique('e2e-project');
    await createProject(page, name);

    // createProject already waits for the card, but reload to prove it's real server state
    // (persisted via the project-creation API call), not just optimistic client-side UI.
    await page.reload();
    await expect(page.locator('a', { hasText: name })).toBeVisible();
  });
});
