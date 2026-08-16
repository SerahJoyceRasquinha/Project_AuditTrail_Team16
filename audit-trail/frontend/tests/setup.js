import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom does not implement ResizeObserver, which Recharts' responsive container
// depends on. A minimal stub is enough for the chart to mount in tests.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
