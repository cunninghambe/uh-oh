import { Link, Outlet } from '@tanstack/react-router';

export const Layout = () => (
  <div className="min-h-screen flex flex-col">
    <header className="border-b border-zinc-800 bg-zinc-900 px-6 py-3 flex items-center gap-6">
      <Link to="/" className="font-mono text-lg text-amber-400 hover:text-amber-300">
        uh-oh
      </Link>
      <span className="text-xs text-zinc-500">v0.1 · crash reporting for RN</span>
    </header>
    <main className="flex-1 px-6 py-6">
      <Outlet />
    </main>
  </div>
);
