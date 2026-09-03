import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * These tests are deliberately NOT part of `npm test` in either workspace. They
 * need a browser binary and a running stack, and the unit/integration suites are
 * worth keeping self-contained and offline — a suite that cannot run without a
 * network is a suite people stop running.
 *
 * By default this starts both servers itself, with the backend in `memory`
 * persistence so no MongoDB is required and every run begins from an empty
 * ledger. Point E2E_BASE_URL at an already-running stack (a compose deployment,
 * say) to test that instead, and the servers below are not started.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const useExternalStack = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: './tests',
  /**
   * Serial by default. The tests share one backend, and the dashboard's list
   * view is global state — running them in parallel would make assertions about
   * "the shipments visible on this page" depend on what another worker happened
   * to create a moment earlier. That is a flaky test suite, and a flaky suite
   * teaches people to ignore failures.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: useExternalStack
    ? undefined
    : [
        {
          command: 'npm run dev',
          cwd: '../backend',
          url: 'http://localhost:4001/health',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            PERSISTENCE: 'memory',
            PORT: '4001',
            LOG_LEVEL: 'error',
            AUTH_ENABLED: 'true',
            /**
             * Off. These tests register their own accounts, which is the more
             * honest thing to exercise: it proves the registration contract
             * rather than depending on a convenience the production default
             * disables.
             */
            AUTH_SEED_DEMO_ACCOUNTS: 'false',
            /**
             * The temperature monitor writes events on a timer. Left on, it
             * would append readings underneath a test that is asserting on a
             * version number, and the failure would look like a bug in the
             * command path. Monitoring has its own coverage in
             * tests/integration/temperatureMonitorLifecycle.test.js and in
             * scripts/verifyTemperatureFlow.js.
             */
            SENSOR_MONITOR_ENABLED: 'false',
          },
        },
        {
          command: 'npm run dev',
          cwd: '../frontend',
          url: 'http://localhost:5173',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
