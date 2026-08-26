import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import {
  ShipmentFormDialog,
  validateShipmentForm,
  validateDurationDays,
  changedFields,
  normaliseContainerCode,
} from '../src/components/ShipmentFormDialog.jsx';
import { LifecyclePlanner, boundsFor } from '../src/components/LifecyclePlanner.jsx';
import { resetLocationCache, isSubdivisionOf } from '../src/data/locations.js';
import * as api from '../src/services/apiClient.js';

const CATALOGUE = {
  countries: [
    {
      code: 'IN',
      name: 'India',
      subdivisionLabel: 'State / Union Territory',
      hasSubdivisions: true,
      subdivisions: [
        { code: 'KA', name: 'Karnataka', cities: ['Bengaluru', 'Mangaluru'] },
        { code: 'TN', name: 'Tamil Nadu', cities: ['Chennai', 'Coimbatore', 'Tuticorin'] },
      ],
      cities: [],
    },
    {
      code: 'NL',
      name: 'Netherlands',
      subdivisionLabel: 'Province',
      hasSubdivisions: true,
      subdivisions: [{ code: 'ZH', name: 'South Holland', cities: ['Rotterdam', 'The Hague'] }],
      cities: [],
    },
    {
      code: 'SG',
      name: 'Singapore',
      subdivisionLabel: 'Region',
      hasSubdivisions: false,
      subdivisions: [],
      cities: ['Jurong', 'Singapore', 'Tuas'],
    },
  ],
};

const SHIPMENT = {
  aggregateId: 'SHP-7',
  containerCode: 'MSKU7845123',
  origin: 'Chennai, Tamil Nadu, India',
  destination: 'Rotterdam, South Holland, Netherlands',
  originLocation: { city: 'Chennai', countryCode: 'IN', stateCode: 'TN' },
  destinationLocation: { city: 'Rotterdam', countryCode: 'NL', stateCode: 'ZH' },
  carrier: 'Maersk Line',
  cargoDescription: 'Vaccines',
  estimatedDurationDays: 20,
  minTemperatureC: 2,
  maxTemperatureC: 8,
  currentVersion: 4,
  currentState: 'IN_TRANSIT',
};

const wrap = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

/**
 * The catalogue is fetched, so the selects start empty. Country names appear in
 * both the origin and destination lists, which makes a text query ambiguous -
 * wait on the origin select actually having options instead.
 */
/** Fills one address in the required order: country, then state, then city. */
const selectAddress = (prefix, countryCode, stateCode, city) => {
  fireEvent.change(document.querySelector(`#${prefix}-country`), { target: { value: countryCode } });
  if (stateCode) {
    fireEvent.change(document.querySelector(`#${prefix}-state`), { target: { value: stateCode } });
  }
  fireEvent.change(document.querySelector(`#${prefix}-city`), { target: { value: city } });
};

const waitForCatalogue = () =>
  waitFor(() =>
    expect(document.querySelectorAll('#origin-country option').length).toBeGreaterThan(1)
  );

beforeEach(() => {
  resetLocationCache();
  vi.spyOn(api, 'getLocationCatalogue').mockResolvedValue(CATALOGUE);
});

const emptyForm = (overrides = {}) => ({
  containerCode: '',
  origin: { city: '', countryCode: '', stateCode: '', cityIsCustom: false },
  destination: { city: '', countryCode: '', stateCode: '', cityIsCustom: false },
  estimatedDurationDays: '',
  cargoDescription: '',
  carrier: '',
  minTemperatureC: '',
  maxTemperatureC: '',
  reason: '',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Estimated duration (requirement 7)
// ---------------------------------------------------------------------------

describe('estimated duration validation', () => {
  test('accepts positive whole numbers', () => {
    for (const value of [1, 5, 10, 30, '7']) {
      expect(validateDurationDays(value)).toBeNull();
    }
  });

  test('rejects zero, negatives, decimals, text and empty', () => {
    expect(validateDurationDays(0)).toMatch(/at least 1 day/i);
    expect(validateDurationDays(-1)).toMatch(/at least 1 day/i);
    expect(validateDurationDays(2.5)).toMatch(/whole days only/i);
    expect(validateDurationDays('ten')).toMatch(/whole number/i);
    expect(validateDurationDays('')).toMatch(/required/i);
  });

  test('a decimal is refused rather than silently rounded', () => {
    // Rounding would give the shipment a completion date nobody chose.
    expect(validateDurationDays(2.5)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Container code normalisation (requirement 4)
// ---------------------------------------------------------------------------

describe('container code normalisation', () => {
  test('lowercase input becomes uppercase', () => {
    expect(normaliseContainerCode('msku7845123')).toBe('MSKU7845123');
  });

  test('whitespace is stripped, so casing and spacing cannot fork a container', () => {
    expect(normaliseContainerCode('  msku 784 5123 ')).toBe('MSKU7845123');
  });

  test('the field shows the normalised value as the operator types', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    const input = screen.getByPlaceholderText('MSKU7845123');
    fireEvent.change(input, { target: { value: 'msku999' } });
    expect(input.value).toBe('MSKU999');
  });
});

// ---------------------------------------------------------------------------
// Country / state dependency (requirement 2)
// ---------------------------------------------------------------------------

describe('country and state selection', () => {
  test('the state control is disabled until a country is chosen', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    const state = document.querySelector('#origin-state');
    expect(state).toBeDisabled();
    expect(
      screen.getAllByText(/A state cannot be selected until a country is selected/i).length
    ).toBeGreaterThan(0);
  });

  test('choosing a country enables the state list and offers only its subdivisions', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'IN' } });

    const state = document.querySelector('#origin-state');
    expect(state).not.toBeDisabled();
    const options = [...state.querySelectorAll('option')].map((option) => option.textContent);
    expect(options).toContain('Tamil Nadu');
    expect(options).toContain('Karnataka');
    // South Holland belongs to the Netherlands and must not be offered here.
    expect(options).not.toContain('South Holland');
  });

  test('changing the country clears a state that does not belong to the new one', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'IN' } });
    fireEvent.change(document.querySelector('#origin-state'), { target: { value: 'TN' } });
    expect(document.querySelector('#origin-state').value).toBe('TN');

    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'NL' } });
    expect(document.querySelector('#origin-state').value).toBe('');
  });

  test('a country with no subdivisions says so instead of demanding one', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'SG' } });
    expect(document.querySelector('#origin-state')).toBeDisabled();
    expect(screen.getByText(/Singapore has no separate region to select/i)).toBeInTheDocument();
  });


  test('the city control is disabled until a state is chosen', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    // Country -> State -> City: each level gates the next.
    expect(document.querySelector('#origin-city')).toBeDisabled();

    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'IN' } });
    expect(document.querySelector('#origin-city')).toBeDisabled();
    expect(screen.getAllByText(/Select a state \/ union territory first/i).length).toBeGreaterThan(0);

    fireEvent.change(document.querySelector('#origin-state'), { target: { value: 'TN' } });
    expect(document.querySelector('#origin-city')).not.toBeDisabled();
  });

  test('the city list contains only cities in the chosen state', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'IN' } });
    fireEvent.change(document.querySelector('#origin-state'), { target: { value: 'TN' } });

    const options = [...document.querySelectorAll('#origin-city option')].map((o) => o.textContent);
    expect(options).toContain('Chennai');
    expect(options).toContain('Tuticorin');
    // Bengaluru is in Karnataka, not Tamil Nadu.
    expect(options).not.toContain('Bengaluru');
    // Rotterdam is in another country entirely.
    expect(options).not.toContain('Rotterdam');
  });

  test('changing the state clears a city that does not belong to it', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    selectAddress('origin', 'IN', 'TN', 'Chennai');
    expect(document.querySelector('#origin-city').value).toBe('Chennai');

    fireEvent.change(document.querySelector('#origin-state'), { target: { value: 'KA' } });
    expect(document.querySelector('#origin-city').value).toBe('');
  });

  test('changing the country clears both the state and the city below it', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    selectAddress('origin', 'IN', 'TN', 'Chennai');
    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'NL' } });

    expect(document.querySelector('#origin-state').value).toBe('');
    expect(document.querySelector('#origin-city').value).toBe('');
  });

  test('a country with no subdivisions offers its cities directly', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'SG' } });

    // No state to pick, so the city level opens immediately.
    expect(document.querySelector('#origin-state')).toBeDisabled();
    expect(document.querySelector('#origin-city')).not.toBeDisabled();
    const options = [...document.querySelectorAll('#origin-city option')].map((o) => o.textContent);
    expect(options).toContain('Jurong');
  });

  test('"Other" reveals a text input, because the city list is not exhaustive', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'IN' } });
    fireEvent.change(document.querySelector('#origin-state'), { target: { value: 'TN' } });
    fireEvent.change(document.querySelector('#origin-city'), { target: { value: '__OTHER__' } });

    const manual = document.querySelector('#origin-city-custom');
    expect(manual).toBeInTheDocument();

    // An unlisted port must not be blocked by an incomplete data file.
    fireEvent.change(manual, { target: { value: 'Karaikal Port' } });
    expect(manual.value).toBe('Karaikal Port');
  });

  test('a manually entered city is sent to the backend like any other', async () => {
    const createShipment = vi
      .spyOn(api, 'createShipment')
      .mockResolvedValue({ aggregateId: 'SHP-1', version: 1 });

    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(screen.getByPlaceholderText('MSKU7845123'), { target: { value: 'MSKU1' } });
    fireEvent.change(document.querySelector('#origin-country'), { target: { value: 'IN' } });
    fireEvent.change(document.querySelector('#origin-state'), { target: { value: 'TN' } });
    fireEvent.change(document.querySelector('#origin-city'), { target: { value: '__OTHER__' } });
    fireEvent.change(document.querySelector('#origin-city-custom'), {
      target: { value: 'Karaikal Port' },
    });
    selectAddress('destination', 'NL', 'ZH', 'Rotterdam');
    fireEvent.change(screen.getByPlaceholderText('21'), { target: { value: '20' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Shipment' }));

    await waitFor(() => expect(createShipment).toHaveBeenCalled());
    expect(createShipment.mock.calls[0][0].originLocation.city).toBe('Karaikal Port');
  });

  test('an existing city outside the curated list stays editable when reopened', () => {
    const legacy = {
      ...SHIPMENT,
      originLocation: { city: 'Karaikal Port', countryCode: 'IN', stateCode: 'TN', cityFromCatalogue: false },
    };
    wrap(<ShipmentFormDialog mode="amend" shipment={legacy} onClose={() => {}} />);
    // It must not silently vanish from a dropdown that has no matching option.
    expect(screen.getByDisplayValue('Karaikal Port')).toBeInTheDocument();
  });

  test('subdivision membership is checked against the catalogue', () => {
    expect(isSubdivisionOf(CATALOGUE.countries, 'IN', 'TN')).toBe(true);
    expect(isSubdivisionOf(CATALOGUE.countries, 'IN', 'ZH')).toBe(false);
    expect(isSubdivisionOf(CATALOGUE.countries, 'SG', '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shipment ID (requirement 3)
// ---------------------------------------------------------------------------

describe('shipment reference', () => {
  test('the create form does not ask the user to type a reference', async () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    const field = screen.getByDisplayValue('Assigned automatically');
    expect(field).toBeDisabled();
    expect(screen.getByText(/SHP-1, SHP-2/)).toBeInTheDocument();
  });

  test('the reference is shown read-only when editing and cannot be changed', () => {
    wrap(<ShipmentFormDialog mode="amend" shipment={SHIPMENT} onClose={() => {}} />);
    const field = screen.getByDisplayValue('SHP-7');
    expect(field).toBeDisabled();
    expect(screen.getByText(/cannot be changed/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Form validation and submission
// ---------------------------------------------------------------------------

describe('create form validation', () => {
  test('a create needs a container code, both locations and a duration', () => {
    const issues = validateShipmentForm(emptyForm(), { mode: 'create' });
    expect(issues.containerCode).toBeTruthy();
    expect(issues.origin).toBeTruthy();
    expect(issues.destination).toBeTruthy();
    expect(issues.estimatedDurationDays).toBeTruthy();
  });

  test('a one-sided temperature range is rejected, matching the domain rule', () => {
    const issues = validateShipmentForm(emptyForm({ minTemperatureC: '2' }), { mode: 'amend' });
    expect(issues.minTemperatureC).toMatch(/both bounds/i);
  });

  test('an inverted range is rejected', () => {
    const issues = validateShipmentForm(
      emptyForm({ minTemperatureC: '9', maxTemperatureC: '3' }),
      { mode: 'amend' }
    );
    expect(issues.minTemperatureC).toMatch(/cannot be above/i);
  });

  test('a create sends structured locations and no client-chosen id or timestamp', async () => {
    const createShipment = vi
      .spyOn(api, 'createShipment')
      .mockResolvedValue({ aggregateId: 'SHP-1', version: 1, eventType: 'CONTAINER_CREATED' });

    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} onSucceeded={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(screen.getByPlaceholderText('MSKU7845123'), { target: { value: 'msku1' } });
    selectAddress('origin', 'IN', 'TN', 'Chennai');
    selectAddress('destination', 'NL', 'ZH', 'Rotterdam');
    fireEvent.change(screen.getByPlaceholderText('21'), { target: { value: '20' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Shipment' }));

    await waitFor(() => expect(createShipment).toHaveBeenCalled());
    const payload = createShipment.mock.calls[0][0];

    expect(payload.containerCode).toBe('MSKU1');
    expect(payload.originLocation).toEqual({ city: 'Chennai', countryCode: 'IN', stateCode: 'TN' });
    expect(payload.estimatedDurationDays).toBe(20);
    // The server owns both of these.
    expect(payload.shipmentId).toBeUndefined();
    expect(payload.occurredAt).toBeUndefined();
  });

  test('a rejected create surfaces the backend issue list rather than a generic failure', async () => {
    const error = new api.ApiError('The create-shipment command failed validation.', {
      status: 400,
      code: 'VALIDATION_ERROR',
      details: { issues: [{ field: 'origin.stateCode', message: 'The selected state does not belong to India.' }] },
    });
    vi.spyOn(api, 'createShipment').mockRejectedValue(error);

    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    await waitForCatalogue();

    fireEvent.change(screen.getByPlaceholderText('MSKU7845123'), { target: { value: 'MSKU1' } });
    selectAddress('origin', 'IN', 'TN', 'Chennai');
    selectAddress('destination', 'NL', 'ZH', 'Rotterdam');
    fireEvent.change(screen.getByPlaceholderText('21'), { target: { value: '20' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Shipment' }));

    await waitFor(() =>
      expect(screen.getByText(/The selected state does not belong to India/i)).toBeInTheDocument()
    );
  });
});

describe('amendment diffing', () => {
  test('only genuinely different fields are carried into the command', () => {
    const form = emptyForm({
      containerCode: SHIPMENT.containerCode,
      origin: { city: 'Chennai', countryCode: 'IN', stateCode: 'TN', cityIsCustom: false },
      destination: { city: 'Rotterdam', countryCode: 'NL', stateCode: 'ZH', cityIsCustom: false },
      carrier: SHIPMENT.carrier,
      cargoDescription: SHIPMENT.cargoDescription,
      minTemperatureC: 2,
      maxTemperatureC: 8,
    });
    expect(changedFields(form, SHIPMENT)).toEqual({});

    const changed = changedFields({ ...form, carrier: 'CMA CGM' }, SHIPMENT);
    expect(changed).toEqual({ carrier: 'CMA CGM' });
  });

  test('a changed destination is sent as a structured location', () => {
    const form = emptyForm({
      containerCode: SHIPMENT.containerCode,
      origin: { city: 'Chennai', countryCode: 'IN', stateCode: 'TN', cityIsCustom: false },
      destination: { city: 'Singapore', countryCode: 'SG', stateCode: '', cityIsCustom: false },
    });
    const changed = changedFields(form, SHIPMENT);
    expect(changed.destinationLocation).toEqual({
      city: 'Singapore',
      countryCode: 'SG',
      stateCode: '',
    });
  });

  test('the estimated duration is not editable through the correction form', () => {
    wrap(<ShipmentFormDialog mode="amend" shipment={SHIPMENT} onClose={() => {}} />);
    const field = screen.getByDisplayValue('20 days');
    expect(field).toBeDisabled();
    // It changes by recording a delay, which keeps the reason on the record.
    expect(screen.getByText(/Changed by recording a delay/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle planner (requirements 8-14)
// ---------------------------------------------------------------------------

const SCHEDULE = {
  aggregateId: 'SHP-7',
  currentVersion: 4,
  planned: true,
  createdAt: '2026-03-01T09:00:00.000Z',
  estimatedDurationDays: 20,
  originalEstimatedDurationDays: 20,
  window: { earliest: '2026-03-01', latest: '2026-03-21' },
  plan: {
    LOAD_ON_SHIP: { plannedDate: '2026-03-03', originalPlannedDate: '2026-03-03', details: {} },
    ARRIVE_AT_PORT: { plannedDate: '2026-03-14', originalPlannedDate: '2026-03-14', details: {} },
    UNLOAD_FROM_SHIP: { plannedDate: '2026-03-16', originalPlannedDate: '2026-03-16', details: {} },
  },
  bounds: {
    LOAD_ON_SHIP: { selectable: true, min: '2026-03-01', max: '2026-03-21' },
    ARRIVE_AT_PORT: { selectable: true, min: '2026-03-01', max: '2026-03-21' },
    UNLOAD_FROM_SHIP: { selectable: true, min: '2026-03-01', max: '2026-03-21' },
  },
  stages: [
    {
      stage: 'LOAD_ON_SHIP',
      label: 'Load on Ship',
      status: 'OVERDUE',
      plannedDate: '2026-03-03',
      originalPlannedDate: '2026-03-03',
      overdueByDays: 5,
      earlyByDays: 0,
      lateByDays: 0,
      isBlocked: false,
      details: {},
    },
    {
      stage: 'ARRIVE_AT_PORT',
      label: 'Arrive at Port',
      status: 'PLANNED',
      plannedDate: '2026-03-14',
      originalPlannedDate: '2026-03-14',
      overdueByDays: 0,
      earlyByDays: 0,
      lateByDays: 0,
      isBlocked: true,
      details: {},
    },
    {
      stage: 'UNLOAD_FROM_SHIP',
      label: 'Unload from Ship',
      status: 'PLANNED',
      plannedDate: '2026-03-16',
      originalPlannedDate: '2026-03-16',
      overdueByDays: 0,
      earlyByDays: 0,
      lateByDays: 0,
      isBlocked: true,
      details: {},
    },
  ],
  isOverdue: true,
  isComplete: false,
};

describe('lifecycle planner', () => {
  test('the three stages are shown in their required order', () => {
    wrap(<LifecyclePlanner shipmentId="SHP-7" schedule={SCHEDULE} onChanged={() => {}} />);
    const titles = [...document.querySelectorAll('.stage-card__title')].map((n) => n.textContent);
    expect(titles).toEqual(['Load on Ship', 'Arrive at Port', 'Unload from Ship']);
  });

  test('a stage whose prerequisite is outstanding cannot be confirmed', () => {
    wrap(<LifecyclePlanner shipmentId="SHP-7" schedule={SCHEDULE} onChanged={() => {}} />);
    expect(screen.getByLabelText('Confirm Arrive at Port')).toBeDisabled();
    expect(screen.getByLabelText('Confirm Unload from Ship')).toBeDisabled();
  });

  test('an overdue stage is flagged and offers a schedule extension', () => {
    wrap(<LifecyclePlanner shipmentId="SHP-7" schedule={SCHEDULE} onChanged={() => {}} />);
    expect(screen.getByText(/Overdue by 5 days/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Extend schedule/i })).toBeInTheDocument();
    expect(document.querySelector('.stage-card--overdue')).toBeTruthy();
  });

  test('confirming a stage dispatches a command rather than writing an event', async () => {
    const moveShipment = vi
      .spyOn(api, 'moveShipment')
      .mockResolvedValue({ version: 5, eventType: 'LOADED_ON_SHIP' });

    wrap(<LifecyclePlanner shipmentId="SHP-7" schedule={SCHEDULE} onChanged={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('MV Ganges Star'), {
      target: { value: 'MV Ganges Star' },
    });
    fireEvent.change(screen.getByPlaceholderText('Chennai Port'), {
      target: { value: 'Chennai Port' },
    });
    fireEvent.click(screen.getByLabelText('Confirm Load on Ship'));

    await waitFor(() => expect(moveShipment).toHaveBeenCalled());
    const command = moveShipment.mock.calls[0][0];

    expect(command.movementType).toBe('LOAD_ON_SHIP');
    // The version the screen was loaded against - the basis of OCC.
    expect(command.expectedVersion).toBe(4);
    // Nothing resembling a raw event append.
    expect(command.eventType).toBeUndefined();
    expect(command.payload).toBeUndefined();
  });

  test('an extension sends a positive whole number of days with a reason', async () => {
    const extendSchedule = vi
      .spyOn(api, 'extendSchedule')
      .mockResolvedValue({ version: 5, eventType: 'SHIPMENT_SCHEDULE_EXTENDED' });

    wrap(<LifecyclePlanner shipmentId="SHP-7" schedule={SCHEDULE} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Extend schedule/i }));

    fireEvent.change(screen.getByPlaceholderText('Port congestion at origin'), {
      target: { value: 'Port congestion' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record delay/i }));

    await waitFor(() => expect(extendSchedule).toHaveBeenCalled());
    expect(extendSchedule.mock.calls[0][0]).toMatchObject({
      shipmentId: 'SHP-7',
      stage: 'LOAD_ON_SHIP',
      extensionDays: 1,
      reason: 'Port congestion',
      expectedVersion: 4,
    });
  });

  test('a zero or negative extension is refused before it is sent', async () => {
    const extendSchedule = vi.spyOn(api, 'extendSchedule').mockResolvedValue({});

    wrap(<LifecyclePlanner shipmentId="SHP-7" schedule={SCHEDULE} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Extend schedule/i }));

    const days = document.querySelector('.lifecycle__extend input[type="number"]');
    fireEvent.change(days, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Record delay/i }));

    expect(await screen.findByText(/positive whole number of days/i)).toBeInTheDocument();
    expect(extendSchedule).not.toHaveBeenCalled();
  });

  test('a superseded planned date stays visible alongside the revised one', () => {
    const revised = {
      ...SCHEDULE,
      stages: [
        { ...SCHEDULE.stages[0], status: 'IN_PROGRESS', plannedDate: '2026-03-08', originalPlannedDate: '2026-03-03', overdueByDays: 0 },
        ...SCHEDULE.stages.slice(1),
      ],
    };
    wrap(<LifecyclePlanner shipmentId="SHP-7" schedule={revised} onChanged={() => {}} />);
    // The original plan is struck through, not erased.
    expect(document.querySelector('.stage-card__struck')).toBeTruthy();
  });

  test('the planner is disabled while viewing history, with the reason given', () => {
    wrap(
      <LifecyclePlanner
        shipmentId="SHP-7"
        schedule={SCHEDULE}
        disabled
        disabledReason="Return to the live view before making changes."
        onChanged={() => {}}
      />
    );
    expect(screen.getByText(/Return to the live view/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm Load on Ship')).toBeDisabled();
  });
});

describe('calendar bounds', () => {
  const serverBounds = SCHEDULE.bounds;

  test('a stage cannot be planned before the shipment was created', () => {
    const bounds = boundsFor('LOAD_ON_SHIP', {}, serverBounds);
    expect(bounds.min).toBe('2026-03-01');
  });

  test('the planning window closes at the estimated completion boundary', () => {
    const bounds = boundsFor('UNLOAD_FROM_SHIP', {}, serverBounds);
    expect(bounds.max).toBe('2026-03-21');
  });

  test('a dependent stage cannot start before the stage in front of it', () => {
    const draft = { LOAD_ON_SHIP: { plannedDate: '2026-03-10' } };
    expect(boundsFor('ARRIVE_AT_PORT', draft, serverBounds).min).toBe('2026-03-10');
  });

  test('bounds tighten as earlier stages are chosen', () => {
    const draft = {
      LOAD_ON_SHIP: { plannedDate: '2026-03-05' },
      ARRIVE_AT_PORT: { plannedDate: '2026-03-15' },
    };
    expect(boundsFor('UNLOAD_FROM_SHIP', draft, serverBounds).min).toBe('2026-03-15');
  });

  test('a confirmed stage is not selectable at all', () => {
    const bounds = boundsFor(
      'LOAD_ON_SHIP',
      {},
      { LOAD_ON_SHIP: { selectable: false, min: null, max: null, reason: 'already confirmed' } }
    );
    expect(bounds.selectable).toBe(false);
  });
});
