import { expect, test } from '@playwright/test';

import {
  createProject,
  currentIssueId,
  ingestEvent,
  loginAndLandOnProjects,
  unique,
} from './helpers.js';

// A fresh, run-unique exception type stands in for the "shared exception-type prefix" the
// fleet-wide `/similar` match keys on (similar.ts's exceptionKey: title text before the first
// ':') — this keeps the two issues below the ONLY ones sharing that key for the whole suite run,
// so the Merge modal's similar-issues list can't pick up an unrelated issue from another spec
// file (several of which ingest plain 'TypeError' fixtures against the same long-lived DB).
const EXCEPTION_TYPE = unique('MergeProbeError');
const SOURCE_VALUE = 'merge fixture source crash';
const TARGET_VALUE = 'merge fixture target crash';
// Matches packages/server/src/ingest/fingerprint.ts's computeTitle — see issues.spec.ts's
// ISSUE_TITLE comment for the full rule. Distinct top-frame functions (source/target below) keep
// the two fingerprints — and so the two issues — distinct despite sharing EXCEPTION_TYPE.
const SOURCE_TITLE = `${EXCEPTION_TYPE}: ${SOURCE_VALUE} at sourceFn`;
const TARGET_TITLE = `${EXCEPTION_TYPE}: ${TARGET_VALUE} at targetFn`;

/**
 * v0.9 CONTRACT (SPEC §24 issue merge / E2E catch-up item 7): the full merge flow — open the
 * Merge modal on a source issue, select the fleet-wide similar-issue suggestion (a row click only
 * selects; the modal's own Merge button is the sole confirmation, since merge is irreversible),
 * confirm, and land on the target with its combined event count. The source issue then renders
 * its merged state with a link back to the target.
 */
test.describe('issue merge', () => {
  test('merging moves the source into the target, which shows the combined count', async ({
    page,
    request,
  }) => {
    await loginAndLandOnProjects(page);
    const project = await createProject(page, unique('e2e-merge-project'));
    await ingestEvent(request, project.publicKey, {
      type: EXCEPTION_TYPE,
      value: SOURCE_VALUE,
      stacktrace: [{ function: 'sourceFn', filename: 'app/source.js', lineno: 1, inApp: true }],
    });
    await ingestEvent(request, project.publicKey, {
      type: EXCEPTION_TYPE,
      value: TARGET_VALUE,
      stacktrace: [{ function: 'targetFn', filename: 'app/target.js', lineno: 2, inApp: true }],
    });

    await page.getByRole('link', { name: project.name }).click();
    await page.getByRole('link', { name: SOURCE_TITLE }).click();
    const sourceId = currentIssueId(page);

    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Merge issue' });
    await expect(dialog).toBeVisible();

    // Row click only SELECTS (fills the target field) — it must not merge by itself.
    const targetRow = dialog.getByRole('button', { name: TARGET_TITLE });
    await expect(targetRow).toBeVisible();
    await targetRow.click();
    await expect(targetRow).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog).toBeVisible(); // still open — selecting alone didn't submit anything

    await dialog.getByRole('button', { name: 'Merge', exact: true }).click();

    // Navigated to the target; its event count is the ADDITIVE combination of both issues' own
    // single seeded event each (SPEC §24: "target counters combined ADDITIVELY").
    await expect(page.getByRole('heading', { name: TARGET_TITLE })).toBeVisible();
    await expect(page.getByText('events: 2', { exact: true })).toBeVisible();
    const targetId = currentIssueId(page);

    await page.goto(`/issues/${sourceId}`);
    await expect(page.getByRole('heading', { name: SOURCE_TITLE })).toBeVisible();
    await expect(page.getByText('Merged', { exact: true })).toBeVisible();

    // `mergedInto` is a SIBLING of `issue` on the detail response (derived from
    // fingerprint_aliases, not a stored column); Issue.tsx reads it from there
    // to render the merged banner and the link back to the target.
    await expect(page.getByText('This issue was merged into')).toBeVisible();
    await expect(page.getByRole('link', { name: targetId, exact: true })).toBeVisible();
  });
});
