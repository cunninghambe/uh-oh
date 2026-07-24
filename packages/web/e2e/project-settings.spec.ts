import { expect, test } from '@playwright/test';

import { createProject, loginAndLandOnProjects, unique } from './helpers.js';

/**
 * v0.8 CONTRACT (SPEC §23 release<->commit / §24 E2E catch-up item 4): `repoUrl` round-trips
 * through the project settings form — entered, saved against the real
 * `PATCH /api/projects/:id`, and still there after a full reload (so it's persisted server state,
 * not just optimistic client-side UI — same rationale as projects.spec.ts's reload check).
 */
test.describe('project settings', () => {
  test('repoUrl round-trips: entered, saved, and still there after a reload', async ({ page }) => {
    await loginAndLandOnProjects(page);
    const project = await createProject(page, unique('e2e-settings-project'));
    await page.getByRole('link', { name: project.name }).click();
    await page.getByRole('link', { name: 'Settings' }).click();

    const repoUrl = `https://github.com/uh-oh-e2e/${unique('repo')}`;
    const repoUrlInput = page.locator('#repo-url');
    await repoUrlInput.fill(repoUrl);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    await page.reload();
    await expect(page.locator('#repo-url')).toHaveValue(repoUrl);
  });
});
