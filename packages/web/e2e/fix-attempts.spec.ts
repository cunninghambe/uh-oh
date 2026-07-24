import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  createProject,
  currentIssueId,
  getAdminToken,
  ingestEvent,
  loginAndLandOnProjects,
  unique,
} from './helpers.js';

const EXCEPTION_TYPE = 'ReferenceError';
const EXCEPTION_VALUE = 'fix attempt fixture crash';
// Matches packages/server/src/ingest/fingerprint.ts's computeTitle — see issues.spec.ts's
// ISSUE_TITLE comment for the full rule.
const ISSUE_TITLE = `${EXCEPTION_TYPE}: ${EXCEPTION_VALUE} at renderWidget`;

const REPO_URL = 'https://github.com/uh-oh-e2e/fixture-repo';
const PR_URL = 'https://github.com/uh-oh-e2e/fixture-repo/pull/42';
// 7 lowercase hex chars — the minimum length COMMIT_SHA_RE (fix-attempts.ts) accepts, and short
// enough that CommitLink.tsx's shortSha (first 7 chars) is the whole thing, so the rendered link
// text and the seeded value are identical.
const COMMIT_SHA = 'deadbee';

/**
 * v0.8 CONTRACT (SPEC §23 fix attempts / §24 E2E catch-up item 2): a fix attempt seeded via the
 * REST API (`POST /api/issues/:id/fix-attempts`, JWT-authenticated — this route is agent-or-JWT
 * scoped, and the dashboard itself never creates one) renders its state pill and, once the
 * project has a `repoUrl`, a real commit link on issue detail.
 */
test.describe('fix attempts', () => {
  test('a seeded fix attempt renders its state pill and commit link on issue detail', async ({
    page,
    request,
  }) => {
    await loginAndLandOnProjects(page);
    const project = await createProject(page, unique('e2e-fix-attempts-project'));
    await page.getByRole('link', { name: project.name }).click();

    // Brief: "set the project repoUrl first so the commit link is an <a>" — CommitLink.tsx only
    // links when repoUrl starts with https://, plain text otherwise (format.ts's commitUrl).
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.locator('#repo-url').fill(REPO_URL);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.getByRole('link', { name: `← ${project.name}` }).click();

    await ingestEvent(request, project.publicKey, {
      type: EXCEPTION_TYPE,
      value: EXCEPTION_VALUE,
    });
    await page.reload();
    await page.getByRole('link', { name: ISSUE_TITLE }).click();
    const issueId = currentIssueId(page);

    await expect(page.getByRole('heading', { name: 'Fix attempts' })).toBeVisible();
    await expect(page.getByText('No fix attempts yet.')).toBeVisible();

    const token = await getAdminToken(page);
    await postFixAttempt(request, token, issueId, { prUrl: PR_URL, commitSha: COMMIT_SHA });

    await page.reload();
    await expect(page.getByText('No fix attempts yet.')).not.toBeVisible();
    // A freshly-upserted fix attempt starts 'filed' (FixAttemptsPanel.utils.ts's STATE_PILL) —
    // this route never itself transitions state.
    await expect(page.getByText('filed', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: PR_URL })).toBeVisible();

    const commitLink = page.getByRole('link', { name: COMMIT_SHA, exact: true });
    await expect(commitLink).toBeVisible();
    await expect(commitLink).toHaveAttribute('href', `${REPO_URL}/commit/${COMMIT_SHA}`);
  });
});

/** Seeds a fix attempt via the real `POST /api/issues/:id/fix-attempts` (v0.8 CONTRACT A §23),
 * authenticated with the dashboard's own JWT (see helpers.ts's getAdminToken) since that route is
 * agent-token-or-JWT scoped and this suite never sets `UH_OH_AGENT_TOKEN`. */
const postFixAttempt = async (
  request: APIRequestContext,
  token: string,
  issueId: string,
  body: { prUrl: string; commitSha: string },
): Promise<void> => {
  const res = await request.post(`/api/issues/${issueId}/fix-attempts`, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  if (!res.ok()) {
    throw new Error(`fix-attempt seed failed: ${String(res.status())} ${await res.text()}`);
  }
};
