import { expect, test } from '@playwright/test';

import { checkIn, createProject, loginAndLandOnProjects, unique } from './helpers.js';

/**
 * v0.5 CONTRACT M: monitors are a dead-man's-switch — created by the fleet's first check-in,
 * never by the UI. This spec exercises the full contract end to end against a real server: a
 * fresh project's Monitors section starts in the "no monitors yet" empty state (with the real
 * publicKey substituted into the check-in URL pattern), a raw check-in POST auto-creates the
 * monitor, and it then shows up in the UI with an 'ok' status.
 *
 * Integration note: as of writing, packages/server's CONTRACT M routes (GET .../monitors, POST
 * .../check-in/:slug) were still landing concurrently in the server lane — this spec is written
 * to the *target* contract (see v05-server.md CONTRACT M) and may fail until those routes exist.
 * packages/web itself degrades gracefully in the meantime: MonitorsSection.tsx hides the whole
 * section (no heading, no empty state) rather than erroring when GET .../monitors 404s — see
 * that component's `if (monitorsQ.isError) return null;`.
 */
test.describe('monitors', () => {
  test('a fresh project shows the empty state, and a check-in auto-creates a visible monitor', async ({
    page,
    request,
  }) => {
    await loginAndLandOnProjects(page);
    const project = await createProject(page, unique('e2e-monitors-project'));
    await page.getByRole('link', { name: project.name }).click();
    await expect(page.getByRole('heading', { name: project.name })).toBeVisible();

    // exact: true — the fixture project's own name contains "monitors", and Playwright's
    // default substring name-matching would resolve both headings (strict-mode violation).
    await expect(page.getByRole('heading', { name: 'Monitors', exact: true })).toBeVisible();
    await expect(page.getByText('No monitors yet.')).toBeVisible();
    await expect(
      page.getByText(`POST /ingest/${project.publicKey}/check-in/<slug>?intervalMinutes=N`),
    ).toBeVisible();

    await checkIn(request, project.publicKey, 'nightly-backup', 60);

    await page.reload();
    await expect(page.getByText('nightly-backup')).toBeVisible();
    await expect(page.getByText('ok', { exact: true })).toBeVisible();
  });
});
