import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

import { setUnauthorizedHandler } from './api.js';
import { Layout } from './layout.js';
import { Home } from './pages/Home.js';
import { Issue } from './pages/Issue.js';
import { Login } from './pages/Login.js';
import { Project } from './pages/Project.js';
import { ProjectSettings } from './pages/ProjectSettings.js';
import { Releases } from './pages/Releases.js';

const rootRoute = createRootRoute({ component: Layout });

// `redirect` carries the path the user was on when their session expired / was rejected,
// so Login can send them back after a successful sign-in (M8: 24h JWT expiry mid-session
// shouldn't lose their place).
export type LoginSearch = { redirect?: string };

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): LoginSearch =>
    typeof search['redirect'] === 'string' ? { redirect: search['redirect'] } : {},
  component: Login,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: Project,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/settings',
  component: ProjectSettings,
});

const releasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/releases',
  component: Releases,
});

const issueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/issues/$issueId',
  component: Issue,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  homeRoute,
  projectRoute,
  settingsRoute,
  releasesRoute,
  issueRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Wire api.ts's 401 handling to real (non-reloading) SPA navigation. `router.history.push`
// takes a raw path — unlike `router.navigate`, it isn't checked against the typed route
// tree, which is what we want here since the redirect target is an arbitrary prior URL.
setUnauthorizedHandler((redirectPath) => {
  router.history.push(`/login?redirect=${encodeURIComponent(redirectPath)}`);
});
