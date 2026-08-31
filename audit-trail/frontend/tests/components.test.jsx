import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/hooks/useShipmentData.js', () => ({
  useWorkerStatus: () => ({ lag: { behindBy: 0 } }),
}));

vi.mock('../src/auth/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { displayName: 'Ava', role: 'Operator' }, logout: vi.fn() }),
}));

import { AppLayout } from '../src/layouts/AppLayout.jsx';
import { EventTimeline } from '../src/components/EventTimeline.jsx';
import { StateScrubber } from '../src/components/StateScrubber.jsx';
import { SensorChart } from '../src/components/SensorChart.jsx';
import {
  ConflictDialog,
  ConsistencyBanner,
  ReconciliationPanel,
  ShipmentSummary,
} from '../src/components/ShipmentPanels.jsx';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../src/components/StatusBlocks.jsx';
import { AuditLogToolbar, filterAuditEvents } from '../src/components/AuditLogToolbar.jsx';
import { shipmentReducer, shipmentInitialState, VIEW_MODES } from '../src/store/shipmentStore.jsx';

const events = [
  {
    eventId: 'e1',
    eventType: 'CONTAINER_CREATED',
    version: 1,
    timestamp: '2026-03-01T08:00:00.000Z',
    payload: { containerCode: 'MSKU1', origin: 'Chennai', destination: 'Rotterdam' },
    hash: 'a'.repeat(64),
    previousHash: null,
  },
  {
    eventId: 'e2',
    eventType: 'LOADED_ON_SHIP',
    version: 2,
    timestamp: '2026-03-02T08:00:00.000Z',
    payload: { location: 'Chennai Port', vesselName: 'MV Ganges Star' },
    hash: 'b'.repeat(64),
    previousHash: 'a'.repeat(64),
  },
  {
    eventId: 'e3',
    eventType: 'TEMPERATURE_SPIKE',
    version: 3,
    timestamp: '2026-03-03T08:00:00.000Z',
    payload: { temperatureC: 12.4, thresholdC: 8, direction: 'ABOVE_MAX' },
    hash: 'c'.repeat(64),
    previousHash: 'b'.repeat(64),
  },
];

describe('ThemeToggle', () => {
  test('toggles the document theme between dark and light', () => {
    render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>
    );

    const toggle = screen.getByRole('button', { name: /toggle theme/i });
    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('light');

    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('AuditLogToolbar', () => {
  test('filters events by search text, event type and breach state', () => {
    const filtered = filterAuditEvents(events, 'rotterdam', 'ALL', false);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].eventType).toBe('CONTAINER_CREATED');

    const breachOnly = filterAuditEvents(events, '', 'TEMPERATURE_SPIKE', true);
    expect(breachOnly).toHaveLength(1);
    expect(breachOnly[0].eventType).toBe('TEMPERATURE_SPIKE');
  });

  test('renders the audit log search controls', () => {
    render(
      <AuditLogToolbar
        value=""
        onChange={() => {}}
        eventType="ALL"
        onTypeChange={() => {}}
        breachOnly={false}
        onBreachOnlyChange={() => {}}
      />
    );

    expect(screen.getByPlaceholderText(/search audit log/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /event type/i })).toBeInTheDocument();
  });
});

describe('EventTimeline', () => {
  test('renders every event in the order supplied', () => {
    render(<EventTimeline events={events} selectedEventId={null} onSelect={() => {}} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // The API sorts by version; the component must not reorder.
    expect(items[0]).toHaveTextContent('Container created');
    expect(items[2]).toHaveTextContent('Temperature spike');
  });

  test('shows the version and the raw event type for each entry', () => {
    render(<EventTimeline events={events} selectedEventId={null} onSelect={() => {}} />);
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText(/LOADED_ON_SHIP/)).toBeInTheDocument();
  });

  test('marks a temperature spike as a breach', () => {
    render(<EventTimeline events={events} selectedEventId={null} onSelect={() => {}} />);
    expect(screen.getByText('Breach')).toBeInTheDocument();
  });

  test('reveals payload detail and the hash link only for the selected event', () => {
    const { rerender } = render(
      <EventTimeline events={events} selectedEventId={null} onSelect={() => {}} />
    );
    expect(screen.queryByText('Vessel')).not.toBeInTheDocument();

    rerender(<EventTimeline events={events} selectedEventId="e2" onSelect={() => {}} />);
    expect(screen.getByText('Vessel')).toBeInTheDocument();
    expect(screen.getByText('MV Ganges Star')).toBeInTheDocument();
    expect(screen.getByText('chain')).toBeInTheDocument();
  });

  test('selecting an event calls back with its id', () => {
    const onSelect = vi.fn();
    render(<EventTimeline events={events} selectedEventId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Loaded on ship, version 2/ }));
    expect(onSelect).toHaveBeenCalledWith('e2');
  });

  test('renders an empty state rather than a blank panel', () => {
    render(<EventTimeline events={[]} selectedEventId={null} onSelect={() => {}} />);
    expect(screen.getByText('No events recorded')).toBeInTheDocument();
  });

  test('dims events after the scrub cutoff instead of hiding them', () => {
    render(
      <EventTimeline
        events={events}
        selectedEventId={null}
        onSelect={() => {}}
        cutoffAt="2026-03-02T12:00:00.000Z"
      />
    );
    const items = screen.getAllByRole('listitem');
    // An investigator needs to know later events exist while examining an
    // earlier moment.
    expect(items[2]).toHaveStyle({ opacity: '0.38' });
    expect(items[0]).not.toHaveStyle({ opacity: '0.38' });
  });
});

describe('StateScrubber', () => {
  const bounds = { firstEventAt: '2026-03-01T08:00:00.000Z', lastEventAt: '2026-03-03T08:00:00.000Z' };

  test('renders a slider spanning the event window', () => {
    render(
      <StateScrubber
        bounds={bounds}
        scrubAt={null}
        isHistorical={false}
        onScrub={() => {}}
        onReturnToLive={() => {}}
        events={events}
      />
    );
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', String(Date.parse(bounds.firstEventAt)));
    expect(slider).toHaveAttribute('max', String(Date.parse(bounds.lastEventAt)));
  });

  test('shows "live" until the scrubber is engaged', () => {
    render(
      <StateScrubber
        bounds={bounds}
        scrubAt={null}
        isHistorical={false}
        onScrub={() => {}}
        onReturnToLive={() => {}}
        events={events}
      />
    );
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByText('Viewing current state')).toBeInTheDocument();
  });

  test('committing a position emits an ISO timestamp', () => {
    const onScrub = vi.fn();
    render(
      <StateScrubber
        bounds={bounds}
        scrubAt={null}
        isHistorical={false}
        onScrub={onScrub}
        onReturnToLive={() => {}}
        events={events}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Reconstruct at this instant/ }));
    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('explains itself when there is nothing to scrub through', () => {
    render(
      <StateScrubber
        bounds={{ firstEventAt: '2026-03-01T08:00:00.000Z', lastEventAt: '2026-03-01T08:00:00.000Z' }}
        scrubAt={null}
        isHistorical={false}
        onScrub={() => {}}
        onReturnToLive={() => {}}
        events={[events[0]]}
      />
    );
    expect(screen.getByText(/at least two events/)).toBeInTheDocument();
  });

  test('return to live is only enabled while viewing the past', () => {
    const { rerender } = render(
      <StateScrubber
        bounds={bounds}
        scrubAt={null}
        isHistorical={false}
        onScrub={() => {}}
        onReturnToLive={() => {}}
        events={events}
      />
    );
    expect(screen.getByRole('button', { name: 'Return to live' })).toBeDisabled();

    rerender(
      <StateScrubber
        bounds={bounds}
        scrubAt="2026-03-02T00:00:00.000Z"
        isHistorical
        onScrub={() => {}}
        onReturnToLive={() => {}}
        events={events}
      />
    );
    expect(screen.getByRole('button', { name: 'Return to live' })).toBeEnabled();
  });
});

describe('SensorChart', () => {
  const series = {
    unit: 'celsius',
    range: { minTemperatureC: 2, maxTemperatureC: 8 },
    readings: [
      { eventId: 'e2', version: 2, timestamp: '2026-03-02T08:00:00.000Z', epoch: Date.parse('2026-03-02T08:00:00.000Z'), temperatureC: 4.2, isBreach: false },
      { eventId: 'e3', version: 3, timestamp: '2026-03-03T08:00:00.000Z', epoch: Date.parse('2026-03-03T08:00:00.000Z'), temperatureC: 12.4, isBreach: true, direction: 'ABOVE_MAX', thresholdC: 8 },
    ],
    markers: [
      { eventId: 'e1', version: 1, eventType: 'CONTAINER_CREATED', timestamp: '2026-03-01T08:00:00.000Z', epoch: Date.parse('2026-03-01T08:00:00.000Z') },
    ],
    summary: { readingCount: 2, breachCount: 1 },
  };

  test('renders the chart and states the acceptable range', () => {
    const { container } = render(<SensorChart series={series} selectedEventId={null} onSelectEvent={() => {}} />);
    expect(container.querySelector('.chart')).toBeTruthy();
    expect(screen.getByText(/Acceptable range/)).toBeInTheDocument();
  });

  test('handles a shipment with no readings', () => {
    render(<SensorChart series={{ ...series, readings: [] }} selectedEventId={null} onSelectEvent={() => {}} />);
    expect(screen.getByText('No sensor readings')).toBeInTheDocument();
  });

  test('handles a missing series without crashing', () => {
    render(<SensorChart series={null} selectedEventId={null} onSelectEvent={() => {}} />);
    expect(screen.getByText('No sensor readings')).toBeInTheDocument();
  });

  test('says so plainly when no range was declared', () => {
    render(
      <SensorChart
        series={{ ...series, range: { minTemperatureC: null, maxTemperatureC: null } }}
        selectedEventId={null}
        onSelectEvent={() => {}}
      />
    );
    expect(screen.getByText(/No temperature range was declared/)).toBeInTheDocument();
  });

  test('notes when the series was truncated to match a historical state', () => {
    render(
      <SensorChart
        series={{ ...series, truncatedAt: '2026-03-02T12:00:00.000Z' }}
        selectedEventId={null}
        onSelectEvent={() => {}}
      />
    );
    expect(screen.getByText(/Truncated to/)).toBeInTheDocument();
  });
});

describe('ShipmentSummary', () => {
  const shipment = {
    aggregateId: 'SHP-1001',
    containerCode: 'MSKU1',
    origin: 'Chennai',
    destination: 'Rotterdam',
    currentState: 'IN_TRANSIT',
    currentVersion: 3,
    currentLocation: 'Chennai Port',
    latestTemperatureC: 12.4,
    minTemperatureC: 2,
    maxTemperatureC: 8,
    temperatureExcursion: true,
    temperatureBreachCount: 1,
    temperatureReadingCount: 2,
    lastEventAt: '2026-03-03T08:00:00.000Z',
  };

  test('labels the live view as current state', () => {
    render(<ShipmentSummary shipment={shipment} mode="LIVE" />);
    expect(screen.getByText('Current state')).toBeInTheDocument();
    expect(screen.queryByText('Historical state')).not.toBeInTheDocument();
  });

  test('labels a reconstructed view as historical and states the instant', () => {
    render(<ShipmentSummary shipment={shipment} mode="HISTORICAL" at="2026-03-02T00:00:00.000Z" />);
    // Current and historical must never be confusable.
    expect(screen.getByText('Historical state')).toBeInTheDocument();
    expect(screen.getByText(/As reconstructed at/)).toBeInTheDocument();
  });

  test('surfaces a temperature excursion', () => {
    render(<ShipmentSummary shipment={shipment} mode="LIVE" />);
    expect(screen.getByText('1 breach')).toBeInTheDocument();
  });
});

describe('ConsistencyBanner', () => {
  test('stays out of the way when the projection is current', () => {
    const { container } = render(<ConsistencyBanner consistency={{ projected: true, lagVersions: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('explains the lag without claiming the command failed', () => {
    render(<ConsistencyBanner consistency={{ projected: false, lagVersions: 2 }} />);
    expect(screen.getByText('Synchronising')).toBeInTheDocument();
    expect(screen.getByText(/authoritative record/)).toBeInTheDocument();
  });
});

describe('ReconciliationPanel', () => {
  test('confirms when the projection matches event history', () => {
    render(
      <ReconciliationPanel
        reconciliation={{ consistent: true, expectedVersion: 4, actualVersion: 4, lagVersions: 0 }}
        isLoading={false}
        isError={false}
        onRetry={() => {}}
      />
    );
    expect(screen.getByText('Read model verified')).toBeInTheDocument();
    expect(screen.getByText('History v4')).toBeInTheDocument();
    expect(screen.getByText(/matches a fresh replay/)).toBeInTheDocument();
  });

  test('lists projection drift and supports a manual recheck', () => {
    const onRetry = vi.fn();
    render(
      <ReconciliationPanel
        reconciliation={{
          consistent: false,
          expectedVersion: 5,
          actualVersion: 4,
          lagVersions: 1,
          discrepancies: [{ field: 'currentLocation', actual: 'Port A', expected: 'At sea' }],
        }}
        isLoading={false}
        isError={false}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Read model drift detected')).toBeInTheDocument();
    expect(screen.getByText(/currentLocation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('offers retry when reconciliation fails', () => {
    const onRetry = vi.fn();
    render(<ReconciliationPanel isLoading={false} isError onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ConflictDialog', () => {
  const conflict = {
    details: { expectedVersion: 3, currentVersion: 5, applied: false },
  };

  test('shows both versions and says nothing was written', () => {
    render(<ConflictDialog conflict={conflict} onReload={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('v5')).toBeInTheDocument();
    expect(screen.getByText(/Nothing\s+was written to the ledger/)).toBeInTheDocument();
  });

  test('offers a reload action', () => {
    const onReload = vi.fn();
    render(<ConflictDialog conflict={conflict} onReload={onReload} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reload shipment' }));
    expect(onReload).toHaveBeenCalled();
  });

  test('renders nothing when there is no conflict', () => {
    const { container } = render(<ConflictDialog conflict={null} onReload={() => {}} onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('status blocks', () => {
  test('the loading block announces itself to assistive technology', () => {
    render(<LoadingBlock label="Loading events" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  test('the error block shows the message and a retry action', () => {
    const onRetry = vi.fn();
    render(<ErrorBlock error={{ message: 'Request failed.', code: 'X' }} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  test('a network error is distinguished from a request error', () => {
    render(<ErrorBlock error={{ message: 'no', code: 'NETWORK_ERROR' }} />);
    expect(screen.getByText('Cannot reach the API')).toBeInTheDocument();
  });

  test('the empty block invites an action', () => {
    render(<EmptyBlock title="The ledger is empty" message="Seed it first." />);
    expect(screen.getByText('The ledger is empty')).toBeInTheDocument();
  });
});

describe('shipment store transitions', () => {
  test('scrubbing switches to historical mode and clears the selection', () => {
    const state = shipmentReducer(
      { ...shipmentInitialState, selectedEventId: 'e2' },
      { type: 'SCRUB_TO', at: '2026-03-02T00:00:00.000Z' }
    );
    expect(state.viewMode).toBe(VIEW_MODES.HISTORICAL);
    expect(state.scrubAt).toBe('2026-03-02T00:00:00.000Z');
    // A scrub position and a selected event are two different claims about
    // what the user is looking at.
    expect(state.selectedEventId).toBeNull();
  });

  test('returning to live clears the scrub position', () => {
    const scrubbed = shipmentReducer(shipmentInitialState, { type: 'SCRUB_TO', at: '2026-03-02T00:00:00.000Z' });
    const live = shipmentReducer(scrubbed, { type: 'RETURN_TO_LIVE' });
    expect(live.viewMode).toBe(VIEW_MODES.LIVE);
    expect(live.scrubAt).toBeNull();
  });

  test('selecting a different shipment resets all derived state', () => {
    const dirty = {
      ...shipmentInitialState,
      shipmentId: 'SHP-1',
      viewMode: VIEW_MODES.HISTORICAL,
      scrubAt: '2026-03-02T00:00:00.000Z',
      selectedEventId: 'e2',
    };
    const next = shipmentReducer(dirty, { type: 'SELECT_SHIPMENT', shipmentId: 'SHP-2' });
    expect(next.shipmentId).toBe('SHP-2');
    expect(next.viewMode).toBe(VIEW_MODES.LIVE);
    expect(next.scrubAt).toBeNull();
    expect(next.selectedEventId).toBeNull();
  });

  test('a conflict is recorded and can be dismissed', () => {
    const conflicted = shipmentReducer(shipmentInitialState, {
      type: 'COMMAND_CONFLICTED',
      conflict: { details: { currentVersion: 5 } },
    });
    expect(conflicted.conflict).toBeTruthy();
    expect(shipmentReducer(conflicted, { type: 'DISMISS_CONFLICT' }).conflict).toBeNull();
  });

  test('a successful command bumps the refresh token and clears any conflict', () => {
    const withConflict = { ...shipmentInitialState, conflict: { details: {} } };
    const next = shipmentReducer(withConflict, { type: 'COMMAND_SUCCEEDED', at: '2026-03-04T00:00:00.000Z' });
    expect(next.conflict).toBeNull();
    expect(next.lastCommandAt).toBe('2026-03-04T00:00:00.000Z');
  });
});
