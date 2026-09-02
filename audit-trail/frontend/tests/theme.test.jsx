import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';

import { SensorChart } from '../src/components/SensorChart.jsx';
import { LifecyclePlanner } from '../src/components/LifecyclePlanner.jsx';
import {
  applyTheme,
  getInitialTheme,
  useTheme,
  useChartPalette,
  CHART_PALETTE,
  THEMES,
  THEME_KEY,
} from '../src/hooks/useTheme.js';

/**
 * Theme behaviour, and the parts of the interface that were reading colours of
 * their own.
 *
 * jsdom applies no stylesheet, so these tests do not attempt to assert rendered
 * pixels. What they can pin down is everything that decides a colour in
 * JavaScript - which is precisely where the drift was: two charts each carrying
 * a private palette that ignored the theme entirely.
 */

function installStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    keys: () => [...store.keys()],
  });
  return store;
}

beforeEach(() => {
  installStorage();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

// ------------------------------------------------------------------- theming

describe('theme selection', () => {
  test('remembers the saved choice', () => {
    installStorage({ [THEME_KEY]: 'light' });
    expect(getInitialTheme()).toBe(THEMES.LIGHT);
  });

  test('falls back to the system preference when nothing is saved', () => {
    vi.stubGlobal('matchMedia', (query) => ({ matches: query.includes('light') }));
    expect(getInitialTheme()).toBe(THEMES.LIGHT);
  });

  test('publishes the theme where CSS can read it, and remembers it', () => {
    applyTheme(THEMES.LIGHT);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');

    applyTheme(THEMES.DARK);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  test('components track the theme without being passed it', async () => {
    applyTheme(THEMES.DARK);
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(THEMES.DARK);

    // The toggle changes the attribute; a chart three levels down must follow.
    await act(async () => {
      applyTheme(THEMES.LIGHT);
      await Promise.resolve();
    });

    expect(result.current).toBe(THEMES.LIGHT);
  });
});

describe('chart palette', () => {
  test('serves a different palette per theme, with the same semantic slots', () => {
    expect(Object.keys(CHART_PALETTE.light).sort()).toEqual(Object.keys(CHART_PALETTE.dark).sort());
    expect(CHART_PALETTE.light.amber).not.toBe(CHART_PALETTE.dark.amber);
  });

  test('the light palette is genuinely darker, so labels read on white', () => {
    // A crude luminance proxy is enough to catch the failure that mattered:
    // dark-theme signal colours re-used unchanged on a white background.
    const brightness = (hex) => {
      const value = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
      return (r * 299 + g * 587 + b * 114) / 1000;
    };

    for (const key of ['teal', 'amber', 'violet', 'red', 'green']) {
      expect(brightness(CHART_PALETTE.light[key])).toBeLessThan(brightness(CHART_PALETTE.dark[key]));
    }
  });

  test('the hook resolves to the palette for the active theme', () => {
    applyTheme(THEMES.LIGHT);
    const { result } = renderHook(() => useChartPalette());
    expect(result.current).toEqual(CHART_PALETTE.light);
  });
});

// -------------------------------------------------------- the sensor chart

const series = {
  aggregateId: 'SHP-1',
  unit: 'celsius',
  range: { minTemperatureC: 2, maxTemperatureC: 8 },
  readings: [
    {
      eventId: 'e1',
      version: 2,
      timestamp: '2026-03-01T10:01:00.000Z',
      epoch: Date.parse('2026-03-01T10:01:00.000Z'),
      temperatureC: 4.2,
      isBreach: false,
      source: 'SIMULATED',
    },
    {
      eventId: 'e2',
      version: 3,
      timestamp: '2026-03-01T11:01:00.000Z',
      epoch: Date.parse('2026-03-01T11:01:00.000Z'),
      temperatureC: 9.6,
      isBreach: true,
      direction: 'ABOVE_MAX',
      thresholdC: 8,
      source: 'SIMULATED',
    },
  ],
  markers: [],
  summary: { readingCount: 2, breachCount: 1 },
  truncatedAt: null,
};

describe('SensorChart', () => {
  test('renders the readings it is given, in both themes', () => {
    for (const theme of [THEMES.DARK, THEMES.LIGHT]) {
      applyTheme(theme);
      const { unmount } = render(
        <SensorChart series={series} selectedEventId={null} onSelectEvent={() => {}} />
      );

      // The legend is the part with real text; the SVG itself has no layout in
      // jsdom, so asserting on it would prove nothing.
      expect(screen.getByText(/recorded breach/i)).toBeInTheDocument();
      expect(screen.getByText(/acceptable range/i)).toBeInTheDocument();
      unmount();
    }
  });

  test('labels simulated data as simulated', () => {
    render(<SensorChart series={series} selectedEventId={null} onSelectEvent={() => {}} />);
    expect(screen.getByText(/simulated, not measured/i)).toBeInTheDocument();
  });

  /**
   * The empty state is the thing that made the section look broken. A shipment
   * created moments ago has no readings *yet*, and saying only "no sensor
   * readings" invites someone to conclude the feature is dead.
   */
  test('explains that the first reading is still pending, rather than reporting nothing', () => {
    render(
      <SensorChart
        series={{ ...series, readings: [] }}
        selectedEventId={null}
        onSelectEvent={() => {}}
        shipmentCreatedAt={new Date().toISOString()}
      />
    );

    expect(screen.getByText(/monitoring has started/i)).toBeInTheDocument();
    expect(screen.getByText(/hourly after that/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to refresh/i)).toBeInTheDocument();
  });

  test('says so plainly once monitoring has ended', () => {
    render(
      <SensorChart
        series={{ ...series, readings: [] }}
        selectedEventId={null}
        onSelectEvent={() => {}}
        shipmentCreatedAt="2026-01-01T00:00:00.000Z"
        monitoringStopped
      />
    );

    expect(screen.getByText(/monitoring has ended/i)).toBeInTheDocument();
  });

  test('distinguishes an empty historical view from an empty live one', () => {
    render(
      <SensorChart
        series={{ ...series, readings: [], truncatedAt: '2026-03-01T09:00:00.000Z' }}
        selectedEventId={null}
        onSelectEvent={() => {}}
        shipmentCreatedAt="2026-03-01T08:00:00.000Z"
      />
    );

    expect(screen.getByText(/no readings yet at this point in time/i)).toBeInTheDocument();
  });

  test('falls back to the plain empty message with no context to offer', () => {
    render(<SensorChart series={{ ...series, readings: [] }} selectedEventId={null} onSelectEvent={() => {}} />);
    expect(screen.getByText(/no sensor readings/i)).toBeInTheDocument();
  });
});

// ------------------------------------------------------------ calendar icon

describe('the tentative date control', () => {
  const schedule = {
    shipmentId: 'SHP-1',
    planned: false,
    schedule: null,
    stages: [
      { stage: 'LOAD_ON_SHIP', status: 'PENDING' },
      { stage: 'ARRIVE_AT_PORT', status: 'PENDING' },
      { stage: 'UNLOAD_FROM_SHIP', status: 'PENDING' },
    ],
    bounds: { earliest: '2026-03-01', latest: '2026-03-20' },
    window: { earliest: '2026-03-01', latest: '2026-03-20' },
  };

  test('carries the class that paints its calendar icon white', () => {
    render(<LifecyclePlanner shipmentId="SHP-1" schedule={schedule} onChanged={() => {}} onConflict={() => {}} />);

    const dateInputs = screen.getAllByTestId(/^planned-date-/);
    expect(dateInputs.length).toBeGreaterThan(0);

    for (const input of dateInputs) {
      expect(input).toHaveAttribute('type', 'date');
      expect(input).toHaveClass('input--calendar-white');
    }
  });
});
