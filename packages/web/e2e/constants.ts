// Shared by playwright.config.ts, global-setup.ts and the spec/helper files.
//
// Ports are fixed (not OS-assigned/ephemeral) on purpose: Playwright's `use.baseURL` in
// playwright.config.ts is a plain value resolved once when the config file loads, which
// happens *before* globalSetup runs — so a genuinely ephemeral port picked inside global-setup
// would not be known yet when baseURL needs it. Fixed, high, uncommon ports sidestep that
// ordering problem with no IPC between processes required. They're chosen well away from the
// project's real dev ports (3300 / 5173) so a developer's own `pnpm dev` isn't disturbed.
// global-setup.ts fails fast with a clear error if either port is already taken (e.g. a stale
// process from a crashed previous e2e run) rather than silently falling back to another port.
export const E2E_SERVER_PORT = 34599;
export const E2E_WEB_PORT = 34598;

export const E2E_SERVER_URL = `http://127.0.0.1:${String(E2E_SERVER_PORT)}`;
export const E2E_BASE_URL = `http://127.0.0.1:${String(E2E_WEB_PORT)}`;

// Throwaway credentials for the throwaway server instance global-setup boots — never used
// against a real deployment.
export const E2E_ADMIN_PASSWORD = 'uh-oh-e2e-admin-password';
export const E2E_JWT_SECRET = 'uh-oh-e2e-jwt-secret-at-least-32-characters-long-ok';
export const E2E_WRONG_PASSWORD = 'definitely-not-the-password';

// v0.9 CONTRACT (SPEC §24 E2E catch-up): the env var global-setup.ts stashes the booted server's
// temp SQLite path under, for the couple of scenarios that seed columns only a background sweep
// normally writes (see db.ts) — issues.spike_active/last_spike_at and monitors.last_probe_at/
// last_probe_status. Setting `process.env[E2E_DB_PATH_ENV]` inside globalSetup, before Playwright
// forks any test worker, is the documented way to hand data from globalSetup to the tests
// themselves (workers inherit the parent process's env at spawn time) — no IPC/temp-file needed,
// same ordering rationale as the fixed ports above.
export const E2E_DB_PATH_ENV = 'UH_OH_E2E_DB_PATH';
