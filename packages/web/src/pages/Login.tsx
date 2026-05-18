import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';

import { ApiError, api } from '../api.js';
import { isAuthed, setToken } from '../auth.js';

export const Login = () => {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Already logged in — redirect home
  if (isAuthed()) {
    void navigate({ to: '/', replace: true });
    return null;
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!password || pending) return;
    setPending(true);
    setError(null);
    api
      .login(password)
      .then(({ token }) => {
        setToken(token);
        void navigate({ to: '/', replace: true });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) {
          if (err.status === 429) {
            setError('Too many attempts; try again in a minute.');
          } else {
            setError('Invalid password.');
          }
        } else {
          setError('Unexpected error. Try again.');
        }
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <span className="font-mono text-3xl text-amber-400">uh-oh</span>
          <p className="mt-2 text-sm text-zinc-500">Sign in to your dashboard</p>
        </div>
        <form
          onSubmit={handleSubmit}
          className="rounded border border-zinc-800 bg-zinc-900 p-6 space-y-4"
        >
          <div className="space-y-1">
            <label htmlFor="password" className="block text-xs text-zinc-400 font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setPassword(e.target.value);
              }}
              autoComplete="current-password"
              required
              className="w-full rounded bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
            />
          </div>
          {error && (
            <div role="alert" className="text-sm text-red-400">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={!password || pending}
            className="w-full rounded bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
};
