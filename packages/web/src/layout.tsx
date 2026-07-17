import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';

import { api } from './api.js';
import { isAuthed, minutesUntilExpiry, setToken } from './auth.js';

const EXPIRY_WARNING_MINUTES = 30;
const EXPIRY_CHECK_INTERVAL_MS = 30_000;

export const Layout = () => {
  // All hooks are called unconditionally, every render, in the same order — the previous
  // version had `useCallback` after an early `return null`, so an unauthenticated visit to a
  // protected route called fewer hooks than an authenticated one and React threw "Rendered
  // more hooks than during the previous render" the moment auth state changed mid-session.
  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const authed = isAuthed();
  const [expiryMinutes, setExpiryMinutes] = useState<number | null>(() => minutesUntilExpiry());

  const handleLogout = useCallback(() => {
    void api.logout().finally(() => {
      setToken(null);
      void navigate({ to: '/login', replace: true });
    });
  }, [navigate]);

  // Redirect (via the router, not a hard reload) if not authed and not already on /login.
  useEffect(() => {
    if (!authed && currentPath !== '/login') {
      void navigate({ to: '/login', search: { redirect: currentPath }, replace: true });
    }
  }, [authed, currentPath, navigate]);

  // Optional: warn a bit before the 24h token silently expires mid-session (M8).
  useEffect(() => {
    if (!authed) return;
    const tick = (): void => {
      setExpiryMinutes(minutesUntilExpiry());
    };
    tick();
    const id = setInterval(tick, EXPIRY_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, [authed]);

  // Render nothing while the redirect effect above is about to fire, to avoid a flash of
  // protected content. Safe: this return happens after every hook has already been called.
  if (!authed && currentPath !== '/login') {
    return null;
  }

  const showExpiryWarning =
    authed && expiryMinutes !== null && expiryMinutes > 0 && expiryMinutes < EXPIRY_WARNING_MINUTES;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-zinc-800 bg-zinc-900 px-6 py-3 flex items-center gap-6">
        <Link to="/" className="font-mono text-lg text-amber-400 hover:text-amber-300">
          uh-oh
        </Link>
        <span className="text-xs text-zinc-500">v0.1 · crash reporting for RN</span>
        {authed && (
          <div className="ml-auto flex items-center gap-3">
            {showExpiryWarning && (
              <span role="status" className="text-xs text-amber-400">
                Session expires in {Math.ceil(expiryMinutes ?? 0)}m
              </span>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-2 py-1 hover:border-zinc-500"
            >
              Logout
            </button>
          </div>
        )}
      </header>
      <main className="flex-1 px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
};
