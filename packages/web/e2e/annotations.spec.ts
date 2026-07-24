import { expect, test } from '@playwright/test';

import { createProject, ingestEvent, loginAndLandOnProjects, unique } from './helpers.js';

const EXCEPTION_TYPE = 'RangeError';
const EXCEPTION_VALUE = 'annotation fixture crash';
// Matches packages/server/src/ingest/fingerprint.ts's computeTitle — see issues.spec.ts's
// ISSUE_TITLE comment for the full rule.
const ISSUE_TITLE = `${EXCEPTION_TYPE}: ${EXCEPTION_VALUE} at renderWidget`;

/**
 * v0.8 CONTRACT (SPEC §23 annotations / §24 E2E catch-up item 1): adding an annotation through
 * the issue-detail UI's AnnotationTimeline form — a real `POST /api/issues/:id/annotations`
 * round trip, not a mocked one — and seeing it render in the timeline.
 */
test.describe('annotations', () => {
  test('adding an annotation through the issue-detail form renders it in the timeline', async ({
    page,
    request,
  }) => {
    await loginAndLandOnProjects(page);
    const project = await createProject(page, unique('e2e-annotations-project'));
    await ingestEvent(request, project.publicKey, {
      type: EXCEPTION_TYPE,
      value: EXCEPTION_VALUE,
    });

    await page.getByRole('link', { name: project.name }).click();
    await page.getByRole('link', { name: ISSUE_TITLE }).click();

    await expect(page.getByRole('heading', { name: 'Annotations (0)' })).toBeVisible();
    await expect(page.getByText('No annotations yet.')).toBeVisible();

    const body = unique('root cause: off-by-one in the paginator');
    await page.getByLabel('Annotation kind').selectOption('root_cause');
    await page.getByLabel('Annotation body').fill(body);
    await page.getByRole('button', { name: 'Add annotation' }).click();

    await expect(page.getByRole('heading', { name: 'Annotations (1)' })).toBeVisible();
    await expect(page.getByText('No annotations yet.')).not.toBeVisible();
    // Scope to the rendered annotation row (the <pre> holding this specific body) rather than
    // the whole page — the add-form's kind <select> also carries a 'root cause' <option> (every
    // ADDABLE_ANNOTATION_KIND is always in the DOM as an <option>, selected or not), which
    // strict-mode-collides with a bare page-level getByText('root cause').
    const row = page.locator('pre', { hasText: body }).locator('xpath=..');
    await expect(row.getByText(body)).toBeVisible();
    // KindBadge renders the human-friendly label ("root cause", with a space) for the 'root_cause'
    // kind selected above — see AnnotationTimeline.utils.ts's KIND_BADGE.
    await expect(row.getByText('root cause', { exact: true })).toBeVisible();
    // The dashboard's add-annotation form always speaks for a person (AnnotationTimeline.tsx
    // hardcodes author: 'human'), distinct from the agent-token callers that default to 'agent'.
    await expect(row.getByText('human', { exact: true })).toBeVisible();
  });
});
