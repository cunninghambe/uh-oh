import { expect, test } from '@playwright/test';

import { createProject, ingestUsage, loginAndLandOnProjects, unique } from './helpers.js';

/**
 * v0.6 CONTRACT U-IN / U-API: privacy-first usage analytics — pageviews, visitors, and custom
 * events. This spec ingests a few usage events via the public /ingest/:publicKey/usage endpoint
 * and confirms the Usage section on the project page renders the resulting totals and top-lists.
 *
 * Integration note: as of writing, packages/server's CONTRACT U-IN/U-API routes (POST
 * .../usage, GET .../usage/summary) were still landing concurrently in the server lane — this
 * spec is written to the *target* contract (see v06-server.md) and may fail until those routes
 * exist. packages/web itself degrades gracefully in the meantime: UsageSection.tsx hides the
 * whole section (no heading, no empty state) rather than erroring when GET .../usage/summary
 * errors — see that component's `if (usageQ.isError) return null;`.
 */
test.describe('usage', () => {
  test('ingested pageviews, a referrer, and a custom event show up in the Usage section', async ({
    page,
    request,
  }) => {
    await loginAndLandOnProjects(page);
    const project = await createProject(page, unique('e2e-usage-project'));

    await ingestUsage(request, project.publicKey, [
      { type: 'pageview', path: '/docs' },
      { type: 'pageview', path: '/docs', referrer: 'https://google.com/search?q=uh-oh' },
      { type: 'pageview', path: '/pricing' },
      { type: 'event', name: 'signup_clicked' },
    ]);

    await page.getByRole('link', { name: project.name }).click();
    await expect(page.getByRole('heading', { name: project.name })).toBeVisible();

    // exact: true — the fixture project's own name contains "usage" (unique(...) prefixes it
    // literally), and Playwright's default substring name-matching would resolve both headings
    // (strict-mode violation, same pitfall monitors.spec.ts documents for "monitors").
    await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();

    // Headline totals: 3 pageviews, 1 custom event recorded for the window.
    await expect(page.getByText('pageviews')).toBeVisible();
    await expect(page.getByText('custom events')).toBeVisible();

    // Top pages/referrers/events lists render the ingested rows.
    await expect(page.getByText('/docs')).toBeVisible();
    await expect(page.getByText('/pricing')).toBeVisible();
    await expect(page.getByText('google.com')).toBeVisible();
    await expect(page.getByText('signup_clicked')).toBeVisible();

    // The empty-state hint (shown when there is no usage at all) must not appear once data exists.
    await expect(page.getByText(/No usage recorded yet/)).not.toBeVisible();
  });
});
