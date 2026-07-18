import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '../api.js';
import { getToken, setToken } from '../auth.js';
import { Login } from './Login.js';

const Home = () => <div>home-page</div>;
const Other = () => <div>other-page</div>;

/** A minimal router — just /login (the real route, with its real search validation) plus two
 * dummy destinations — so these tests don't have to pull in (and mock) the whole app. */
const buildRouter = (initialPath: string) => {
  const rootRoute = createRootRoute();
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
      typeof search['redirect'] === 'string' ? { redirect: search['redirect'] } : {},
    component: Login,
  });
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home });
  const otherRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/other',
    component: Other,
  });
  const routeTree = rootRoute.addChildren([loginRoute, homeRoute, otherRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
};

const renderLogin = (initialPath: string) => {
  const router = buildRouter(initialPath);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
};

describe('Login (H1: wrong password shows and keeps its error)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "Invalid password." on a 401 and does not navigate away', async () => {
    // Rejecting with the real ApiError class matters — Login branches on `instanceof ApiError`.
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError(401, 'invalid credentials'));

    renderLogin('/login');

    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid password.');
    // Still on the login form — not redirected/reloaded away from it.
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('shows the rate-limit message on a 429', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError(429, 'rate limited'));

    renderLogin('/login');
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many attempts/i);
  });

  it('on success, stores the token and returns to the ?redirect path (M8 round-trip)', async () => {
    vi.spyOn(api, 'login').mockResolvedValue({ token: 'new-token' });

    const router = renderLogin('/login?redirect=%2Fother');
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'correct' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText('other-page')).toBeInTheDocument();
    });
    expect(getToken()).toBe('new-token');
    expect(router.state.location.pathname).toBe('/other');
  });

  it('redirects immediately if already authenticated', async () => {
    setToken(
      // A real base64url JWT with a far-future exp so isAuthed() is true.
      `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      )}.sig`,
    );

    renderLogin('/login');

    await waitFor(() => {
      expect(screen.getByText('home-page')).toBeInTheDocument();
    });
  });
});
