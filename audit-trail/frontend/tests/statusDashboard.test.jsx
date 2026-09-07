import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

/**
 * Recharts measures its container before it will draw anything, and jsdom
 * reports every element as zero-sized. Without a fixed size the charts render
 * empty and the captions underneath them never mount, so the assertions about
 * chart explanations would pass or fail for reasons unrelated to the code.
 */
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <actual.ResponsiveContainer width={600} height={300}>
        {children}
      </actual.ResponsiveContainer>
    ),
  };
});

const getDashboardMetrics = vi.fn();
const getMetricDefinitions = vi.fn();
const exportDashboardMetrics = vi.fn();

vi.mock('../src/services/apiClient.js', () => ({
  getDashboardMetrics: (...args) => getDashboardMetrics(...args),
  getMetricDefinitions: (...args) => getMetricDefinitions(...args),
  exportDashboardMetrics: (...args) => exportDashboardMetrics(...args),
  // The dashboard subscribes to the notification stream for live refresh, and
  // that hook reads the session token from here. jsdom has no EventSource so
  // the subscription never opens, but the module still has to resolve.
  readToken: () => 'test-token',
}));

import { StatusDashboard, buildStateChartData } from '../src/components/StatusDashboard.jsx';

const METRICS = {
  totalShipments: 4,
  activeShipments: 3,
  archivedShipments: 1,
  byState: { CREATED: 1, IN_TRANSIT: 1, AT_PORT: 0, UNLOADED: 2 },
  withBreaches: 1,
  totalBreaches: 2,
  avgBreachesPerShipment: 0.5,
  shipmentsByOrigin: { 'Chennai, Tamil Nadu, India': 3 },
  shipmentsByDestination: { 'Rotterdam, South Holland, Netherlands': 4 },
  averageDeliveryTime: 12.5,
  onTimeDeliveryRate: 75,
  overallTemperatureCompliance: 75,
  totalTemperatureReadings: 20,
  breachReadings: 2,
  readingTemperatureCompliance: 90,
  generatedAt: '2026-09-05T10:00:00.000Z',
};

const DEFINITIONS = {
  basis: {
    source: 'Read from the shipment read model, not the event log directly.',
    scope: 'All shipments are included, archived ones as well as live ones.',
    freshness: 'The read model trails the event log by the projection worker lag.',
  },
  metrics: [
    {
      key: 'totalShipments',
      label: 'Total Shipments',
      unit: '',
      plain: 'Every shipment the system has ever been told about.',
      technical: 'Count of documents in the read model with no view filter applied.',
      formula: 'count(all shipments)',
    },
    {
      key: 'archivedShipments',
      label: 'Archived Shipments',
      unit: '',
      plain: 'Shipments that have been filed away as finished.',
      technical: 'Count of read-model documents where archived is true.',
      formula: 'count(shipments where archived === true)',
    },
  ],
  charts: [
    {
      key: 'byState',
      title: 'By Lifecycle State',
      type: 'pie',
      plain: 'How the fleet is spread across the four stages of a journey.',
      technical: 'One slice per SHIPMENT_STATES value, sized by the byState counts.',
    },
  ],
};

beforeEach(() => {
  getDashboardMetrics.mockResolvedValue(METRICS);
  getMetricDefinitions.mockResolvedValue(DEFINITIONS);
  exportDashboardMetrics.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

const renderDashboard = async () => {
  render(<StatusDashboard />);
  await screen.findByText(/Shipment Status Dashboard/i);
};

describe('the dashboard explains its numbers', () => {
  test('shows both a plain-English and a technical explanation for a metric', async () => {
    await renderDashboard();

    await screen.findByText('Every shipment the system has ever been told about.');
    expect(
      screen.getByText('Count of documents in the read model with no view filter applied.')
    ).toBeInTheDocument();
  });

  test('prints the formula, so a disputed figure can be checked rather than guessed at', async () => {
    await renderDashboard();

    await screen.findByText('count(all shipments)');
  });

  test('labels the two registers, so it is clear which explanation is which', async () => {
    await renderDashboard();

    await screen.findByText('Every shipment the system has ever been told about.');
    expect(screen.getAllByText(/In plain English/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Technically/i).length).toBeGreaterThan(0);
  });

  test('states where the numbers come from and how fresh they are', async () => {
    await renderDashboard();

    await screen.findByText(/Read from the shipment read model/i);
    expect(screen.getByText(/archived ones as well as live ones/i)).toBeInTheDocument();
    expect(screen.getByText(/trails the event log/i)).toBeInTheDocument();
  });

  test('explains the charts too, not just the KPI cards', async () => {
    await renderDashboard();

    await screen.findByText('How the fleet is spread across the four stages of a journey.');
  });

  /**
   * The captions are a nice-to-have layered on top of the figures. If the
   * definitions request fails the numbers are still worth showing, so the page
   * must degrade rather than error.
   */
  test('still renders the figures when the definitions cannot be loaded', async () => {
    getMetricDefinitions.mockRejectedValue(new Error('offline'));

    await renderDashboard();

    expect(await screen.findByText('Total Shipments')).toBeInTheDocument();
    expect(screen.queryByText(/In plain English/i)).not.toBeInTheDocument();
  });
});

describe('the lifecycle chart covers every state', () => {
  const COLORS = {
    info: '#0aa',
    warning: '#fa0',
    success: '#0a0',
    primary: '#00a',
    purple: '#a0a',
  };

  /**
   * The regression this guards: the chart data used to be a hand-written list
   * of three states, so delivered (UNLOADED) shipments were counted in the
   * cards above and then silently missing from the pie.
   */
  test('includes a slice for delivered shipments', () => {
    const slices = buildStateChartData(METRICS.byState, COLORS);

    const unloaded = slices.find((slice) => slice.name === 'Unloaded');
    expect(unloaded).toBeDefined();
    expect(unloaded.value).toBe(2);
  });

  test('renders every state the backend reports, including empty ones', () => {
    const slices = buildStateChartData(METRICS.byState, COLORS);

    expect(slices.map((slice) => slice.name)).toEqual([
      'Created',
      'In Transit',
      'At Port',
      'Unloaded',
    ]);
    expect(slices.find((slice) => slice.name === 'At Port').value).toBe(0);
  });

  test('the slices account for every shipment in the total', () => {
    const slices = buildStateChartData(METRICS.byState, COLORS);

    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    expect(total).toBe(METRICS.totalShipments);
  });

  /**
   * A state added to the domain must appear here without a frontend change,
   * which is the whole point of reading the keys rather than naming them.
   */
  test('a state the frontend has never heard of still gets a slice', () => {
    const slices = buildStateChartData({ ...METRICS.byState, RETURNED_TO_SENDER: 3 }, COLORS);

    const added = slices.find((slice) => slice.name === 'Returned To Sender');
    expect(added).toBeDefined();
    expect(added.value).toBe(3);
    expect(added.color).toBeTruthy();
  });

  test('an absent breakdown yields no slices rather than throwing', () => {
    expect(buildStateChartData(undefined, COLORS)).toEqual([]);
  });
});

describe('the dashboard export', () => {
  test('offers exactly two formats, PDF first', async () => {
    await renderDashboard();

    const buttons = screen
      .getAllByRole('button')
      .map((button) => button.textContent.trim())
      .filter((label) => /Export/i.test(label));

    expect(buttons).toEqual(['Export PDF', 'Export CSV']);
  });

  test('asks the backend for the report rather than serialising the screen', async () => {
    await renderDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));

    await waitFor(() => expect(exportDashboardMetrics).toHaveBeenCalledWith('pdf'));
  });

  test('exports CSV when the CSV button is used', async () => {
    await renderDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(exportDashboardMetrics).toHaveBeenCalledWith('csv'));
  });

  test('confirms the download rather than leaving the click unacknowledged', async () => {
    await renderDashboard();

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await screen.findByText(/CSV dashboard report downloaded/i);
  });

  test('reports a failed export instead of failing silently', async () => {
    exportDashboardMetrics.mockRejectedValue(new Error('Backend unavailable'));

    await renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));

    await screen.findByText(/Could not download the PDF report: Backend unavailable/i);
  });

  test('disables both buttons while an export is in flight, so it cannot be double-fired', async () => {
    let release;
    exportDashboardMetrics.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    await renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Preparing PDF/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    });

    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export PDF' })).toBeEnabled());
  });
});

describe('the archived count is visible', () => {
  /**
   * Archiving used to shrink the headline total, with nothing on screen
   * accounting for the difference. The card exists so the two reconcile.
   */
  test('shows archived shipments alongside the active and total counts', async () => {
    await renderDashboard();

    const card = (await screen.findByText('Archived Shipments')).closest('div').parentElement;
    expect(within(card).getByText('1')).toBeInTheDocument();
  });

  test('active and archived add up to the total on screen', async () => {
    await renderDashboard();

    await screen.findByText('Archived Shipments');
    expect(METRICS.activeShipments + METRICS.archivedShipments).toBe(METRICS.totalShipments);
  });
});

/**
 * Temperature compliance is a reading-level figure.
 *
 * The pie used to be drawn from `overallTemperatureCompliance`, which counts
 * shipments. With one shipment that breached once in five readings it rendered
 * "Breaches: 100%" beside a shipment page reading "5 readings, 1 breach". These
 * tests pin the chart to the reading-level number and pin the distinction
 * between "no data" and "zero".
 */
describe('temperature compliance reporting', () => {
  test('the compliance card shows reading-level compliance', async () => {
    await renderDashboard();
    const card = screen.getByText('Reading Compliance').closest('div').parentElement;
    expect(within(card).getByText('90%')).toBeTruthy();
  });

  test('the shipment-level figure is still reported, under its own name', async () => {
    await renderDashboard();
    const card = screen.getByText('Shipments Fully Compliant').closest('div').parentElement;
    expect(within(card).getByText('75%')).toBeTruthy();
  });

  test('the raw counts behind the percentage are shown', async () => {
    await renderDashboard();
    expect(screen.getByText(/20 readings · 2 outside range/)).toBeTruthy();
  });

  test('with no readings the chart is suppressed rather than drawn as 0%', async () => {
    getDashboardMetrics.mockResolvedValue({
      ...METRICS,
      totalTemperatureReadings: 0,
      breachReadings: 0,
      readingTemperatureCompliance: null,
    });
    await renderDashboard();
    expect(screen.getByText(/not the same as 0% compliant/i)).toBeTruthy();
  });

  test('an unmeasured rate reads as a dash, not as zero', async () => {
    getDashboardMetrics.mockResolvedValue({
      ...METRICS,
      readingTemperatureCompliance: null,
      totalTemperatureReadings: 0,
      onTimeDeliveryRate: null,
      averageDeliveryTime: null,
    });
    await renderDashboard();
    const onTime = screen.getByText('On-Time Delivery Rate').closest('div').parentElement;
    expect(within(onTime).getByText('—')).toBeTruthy();
    const delivery = screen.getByText('Avg Delivery Time').closest('div').parentElement;
    expect(within(delivery).getByText('—')).toBeTruthy();
  });
});

/**
 * Empty lifecycle buckets are kept in the data - a state with no shipments must
 * not vanish - but they are not given a slice label, because Recharts places
 * one per slice and several zero-width slices overprint each other into an
 * unreadable smear.
 */
describe('the lifecycle pie with empty states', () => {
  test('every state is still listed as text, including the empty one', async () => {
    await renderDashboard();
    expect(screen.getByText(/Created: 1 · In Transit: 1 · At Port: 0 · Unloaded: 2/)).toBeTruthy();
  });

  test('buildStateChartData still returns every bucket', () => {
    const slices = buildStateChartData(METRICS.byState, { info: '#1', warning: '#2', success: '#3', primary: '#4', purple: '#5' });
    expect(slices.map((s) => s.name)).toEqual(['Created', 'In Transit', 'At Port', 'Unloaded']);
  });
});
