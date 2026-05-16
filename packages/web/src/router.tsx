import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

import { Layout } from './layout.js';
import { Home } from './pages/Home.js';
import { Issue } from './pages/Issue.js';
import { Project } from './pages/Project.js';

const rootRoute = createRootRoute({ component: Layout });

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

const issueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/issues/$issueId',
  component: Issue,
});

const routeTree = rootRoute.addChildren([homeRoute, projectRoute, issueRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
