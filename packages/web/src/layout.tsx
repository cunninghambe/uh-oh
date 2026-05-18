import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';

import { api } from './api.js';
import { isAuthed, setToken } from './auth.js';

export const Layout = () => {
  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const authed = isAuthed();

  // Redirect to /login if not authed and not already on /login
  if (!authed && currentPath !== '/login') {
    void navigate({ to: '/login', replace: true });
    return null;
  }

  const handleLogout = useCallback(() => {
    void api.logout().finally(() => {
      setToken(null);
      void navigate({ to: '/login', replace: true });
    });
  }, [navigate]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-zinc-800 bg-zinc-900 px-6 py-3 flex items-center gap-6">
        <Link to="/" className="font-mono text-lg text-amber-400 hover:text-amber-300">
          uh-oh
        </Link>
        <span className="text-xs text-zinc-500">v0.1 · crash reporting for RN</span>
        {authed && (
          <div className="ml-auto">
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
