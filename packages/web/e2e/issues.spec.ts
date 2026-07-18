import type { Page, APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { createProject, ingestEvent, loginAndLandOnProjects, unique } from './helpers.js';

const EXCEPTION_TYPE = 'TypeError';
const EXCEPTION_VALUE = 'Cannot read properties of undefined';
// Matches packages/server/src/ingest/fingerprint.ts's computeTitle: `${type}: ${value} at
// ${topFrameFunction}` — the top frame is the first inApp, non-internal frame, which is
// helpers.ts's default envelope's first stack frame (function: 'renderWidget').
const ISSUE_TITLE = `${EXCEPTION_TYPE}: ${EXCEPTION_VALUE} at renderWidget`;

/**
 * Logs in, creates a fresh project, ingests one event into it (via a raw fetch to
 * /ingest/<publicKey> — item (d)), and opens that project's issue list. Every test below starts
 * from here so each is self-contained (its own project/issue — no cross-test ordering
 * dependency), and this alone covers (d): "ingest one event ... then the issue appears in the
 * project's list" once the caller asserts on the returned title.
 */
const setupProjectWithOneIssue = async (
  page: Page,
  request: APIRequestContext,
): Promise<{ projectName: string }> => {
  await loginAndLandOnProjects(page);
  const project = await createProject(page, unique('e2e-issue-project'));
  await ingestEvent(request, project.publicKey, {
    type: EXCEPTION_TYPE,
    value: EXCEPTION_VALUE,
  });

  await page.getByRole('link', { name: project.name }).click();
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();

  return { projectName: project.name };
};

test.describe('issues', () => {
  test('d an ingested event creates an issue that appears in the project issue list', async ({
    page,
    request,
  }) => {
    await setupProjectWithOneIssue(page, request);

    await expect(page.getByRole('link', { name: ISSUE_TITLE })).toBeVisible();
  });

  test('e the issue detail page renders the title and raw stack frames', async ({
    page,
    request,
  }) => {
    await setupProjectWithOneIssue(page, request);
    await page.getByRole('link', { name: ISSUE_TITLE }).click();

    await expect(page.getByRole('heading', { name: ISSUE_TITLE })).toBeVisible();
    // The top two stack frames from helpers.ts's default envelope, rendered raw since no
    // symbols were ever uploaded for this release. `exact: true` disambiguates the frame's own
    // <span> from the issue title (h1) and fingerprint line, both of which also contain
    // "renderWidget" as a substring (computeFingerprint / computeTitle both fold in the top
    // frame's function name).
    await expect(page.getByText('renderWidget', { exact: true })).toBeVisible();
    await expect(page.getByText('app/widget.js:42')).toBeVisible();
    await expect(page.getByText('app/index.js:10')).toBeVisible();
  });

  test('f resolving an issue moves it to the Resolved tab', async ({ page, request }) => {
    await setupProjectWithOneIssue(page, request);
    await page.getByRole('link', { name: ISSUE_TITLE }).click();
    await expect(page.getByRole('heading', { name: ISSUE_TITLE })).toBeVisible();

    await page.getByRole('button', { name: 'resolved', exact: true }).click();
    // Wait for the mutation to actually land (the button disables once the issue's own status
    // — refetched after the PATCH — matches 'resolved') before navigating away, rather than
    // racing an in-flight request against the list page's own fetch.
    await expect(page.getByRole('button', { name: 'resolved', exact: true })).toBeDisabled();

    await page.getByRole('link', { name: '← Issues' }).click();
    await page.getByRole('tab', { name: 'resolved' }).click();
    await expect(page.getByRole('link', { name: ISSUE_TITLE })).toBeVisible();

    await page.getByRole('tab', { name: 'open', exact: true }).click();
    await expect(page.getByRole('link', { name: ISSUE_TITLE })).not.toBeVisible();
  });
});
