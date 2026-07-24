import { expect, test } from '@playwright/test';

import {
  createProject,
  ingestEvent,
  ingestUsage,
  loginAndLandOnProjects,
  unique,
} from './helpers.js';

const RELEASE_VERSION = '9.9.9';
const RELEASE_BUILD = '3';
// v0.9 CONTRACT RH-STAMP (SPEC §24): the canonical release identity a real client stamps on every
// usage event — `version+build` — matched by equality against `releases.version || '+' ||
// releases.build` (release-health.ts). A bare version never attributes, so this has to be exact.
const CANONICAL_RELEASE = `${RELEASE_VERSION}+${RELEASE_BUILD}`;
const EVENT_COUNT = 3;
const PAGEVIEW_COUNT = 5;
// events / pageviews × 1000, rounded to 1 decimal (release-health.ts's ratioPer1k) — 3/5×1000=600,
// a whole number so `formatRatio` renders it without a decimal point.
const EXPECTED_RATIO = '600';

/**
 * v0.9 CONTRACT (SPEC §24 release health / usage release attribution / E2E catch-up item 5):
 * seeds crash events and usage pageviews carrying the SAME canonical release identity and
 * confirms the Release health table attributes the pageviews to that release and renders the
 * correct crashes-per-1k-pageviews ratio.
 */
test.describe('release health', () => {
  test('renders from seeded events + usage, with a correct crash ratio', async ({
    page,
    request,
  }) => {
    await loginAndLandOnProjects(page);
    const project = await createProject(page, unique('e2e-release-health-project'));

    for (let i = 0; i < EVENT_COUNT; i++) {
      await ingestEvent(request, project.publicKey, {
        type: 'ReleaseHealthError',
        value: `release health fixture crash ${String(i)}`,
        version: RELEASE_VERSION,
        build: RELEASE_BUILD,
      });
    }
    await ingestUsage(
      request,
      project.publicKey,
      Array.from({ length: PAGEVIEW_COUNT }, (_, i) => ({
        type: 'pageview' as const,
        path: `/e2e-release-health/${String(i)}`,
        release: CANONICAL_RELEASE,
      })),
    );

    await page.getByRole('link', { name: project.name }).click();
    await expect(page.getByRole('heading', { name: 'Release health', exact: true })).toBeVisible();

    // Scope to this release's own row (releaseLabel format "version+build") so the assertions
    // below can't accidentally match the totals row or another release. Column order is fixed in
    // ReleaseHealthSection.tsx: Release, Platform, Commit, Events, Fatal, Issues, Pageviews,
    // Crashes/1k — indices 3/6/7 below.
    const row = page.locator('tbody tr').filter({ hasText: CANONICAL_RELEASE });
    await expect(row).toBeVisible();
    await expect(row.locator('td').nth(3)).toHaveText(String(EVENT_COUNT));
    await expect(row.locator('td').nth(6)).toHaveText(String(PAGEVIEW_COUNT));
    await expect(row.locator('td').nth(7)).toHaveText(EXPECTED_RATIO);
  });
});
