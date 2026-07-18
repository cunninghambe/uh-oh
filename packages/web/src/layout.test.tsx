import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { Layout } from './layout.js';
import { setToken } from './auth.js';

const Protected = () => <div>protected-page</div>;
const LoginStub = () => <div>login-page</div>;

const validJwt = (expiresInSeconds: number): string =>
  `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  )}.sig`;

/** A minimal router with Layout as the root — same shape as router.tsx's rootRoute — plus one
 * dummy protected route and a login stub, so we can drive an unauthenticated visit without
 * pulling in (and mocking) every real page. */
const buildRouter = (initialPath: string) => {
  const rootRoute = createRootRoute({ component: Layout });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
      typeof search['redirect'] === 'string' ? { redirect: search['redirect'] } : {},
    component: LoginStub,
  });
  const protectedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/protected',
    component: Protected,
  });
  const routeTree = rootRoute.addChildren([loginRoute, protectedRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
};

const renderLayout = (initialPath: string) => {
  const router = buildRouter(initialPath);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
};

describe('Layout (H2: hoisted hooks — early return before useCallback used to crash)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders an unauthenticated visit to a protected route without throwing, then redirects with ?redirect=', async () => {
    let router: ReturnType<typeof buildRouter> | undefined;

    // The bug this regresses ("Rendered more hooks than during the previous render") throws
    // synchronously out of render() when there's no error boundary — exactly the case here.
    expect(() => {
      router = renderLayout('/protected');
    }).not.toThrow();

    await waitFor(() => {
      expect(screen.getByText('login-page')).toBeInTheDocument();
    });
    expect(router?.state.location.pathname).toBe('/login');
    expect(router?.state.location.search).toMatchObject({ redirect: '/protected' });
  });

  it('renders the protected page and does not redirect when authenticated', async () => {
    setToken(validJwt(3600));

    const router = renderLayout('/protected');

    await waitFor(() => {
      expect(screen.getByText('protected-page')).toBeInTheDocument();
    });
    expect(router.state.location.pathname).toBe('/protected');
  });
});
