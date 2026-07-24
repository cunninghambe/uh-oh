import { expect, test } from '@playwright/test';

import { seedIssueSpiking } from './db.js';
import {
  createProject,
  currentIssueId,
  ingestEvent,
  loginAndLandOnProjects,
  unique,
} from './helpers.js';

const EXCEPTION_TYPE = 'RangeError';
const EXCEPTION_VALUE = 'spike fixture crash';
// Matches packages/server/src/ingest/fingerprint.ts's computeTitle — see issues.spec.ts's
// ISSUE_TITLE comment for the full rule.
const ISSUE_TITLE = `${EXCEPTION_TYPE}: ${EXCEPTION_VALUE} at renderWidget`;

/**
 * v0.8 CONTRACT (SPEC §23 spike detection / §24 E2E catch-up item 3): the spike badge on both the
 * issue list and issue detail while `spikeActive` is set. The real 5-minute sweep is the only
 * thing that normally flips `issues.spike_active` — seeding it directly (db.ts, per the SPEC's
 * own E2E guidance) is what lets this test assert the render without waiting on that timer.
 */
test.describe('spikes', () => {
  test('a spiking issue shows the spike badge on the issue list and its detail page', async ({
    page,
    request,
  }) => {
    await loginAndLandOnProjects(page);
    const project = await createProject(page, unique('e2e-spike-project'));
    await ingestEvent(request, project.publicKey, {
      type: EXCEPTION_TYPE,
      value: EXCEPTION_VALUE,
    });

    await page.getByRole('link', { name: project.name }).click();
    await page.getByRole('link', { name: ISSUE_TITLE }).click();
    const issueId = currentIssueId(page);

    // Not spiking yet — the badge shouldn't render before the (seeded) state transition below.
    await expect(page.getByText('Spike', { exact: true })).not.toBeVisible();

    seedIssueSpiking(issueId);
    await page.reload();

    await expect(page.getByRole('heading', { name: ISSUE_TITLE })).toBeVisible();
    await expect(page.getByText('Spike', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: '← Issues' }).click();
    await expect(page.getByRole('link', { name: ISSUE_TITLE })).toBeVisible();
    await expect(page.getByText('Spike', { exact: true })).toBeVisible();
  });
});
