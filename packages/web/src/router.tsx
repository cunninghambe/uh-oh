import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

import { Layout } from './layout.js';
import { Home } from './pages/Home.js';
import { Issue } from './pages/Issue.js';
import { Login } from './pages/Login.js';
import { Project } from './pages/Project.js';
import { ProjectSettings } from './pages/ProjectSettings.js';
import { Releases } from './pages/Releases.js';

const rootRoute = createRootRoute({ component: Layout });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
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
