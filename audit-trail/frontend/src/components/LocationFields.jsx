import { useLocationCatalogue, findCountry, findSubdivision } from '../data/locations.js';

/**
 * Cascading address selection: **Country → State → City**.
 *
 * Each level is gated on the one above it, structurally rather than by
 * validation message: the state control is `disabled` until a country is
 * chosen, and the city control until a state is. An invalid combination is not
 * merely rejected, it is unreachable. Changing a level clears anything below it
 * that no longer belongs, because silently keeping a stale value is how a form
 * ends up holding a pair the backend will refuse.
 *
 * The city level differs from the two above it in one important way
 * ------------------------------------------------------------------
 * Countries and subdivisions come from ISO 3166 - a closed, authoritative set,
 * so the backend validates them exactly and rejects anything else.
 *
 * Cities have no such registry. The list here is a curated set of ports,
 * freight hubs and capitals; it is genuinely useful and it is genuinely
 * incomplete. So the city dropdown always offers **"Other — enter manually"**,
 * which reveals a text input. Blocking a real shipment because a data file did
 * not happen to list its port would be a much worse failure than an
 * inconsistent spelling, and the backend accepts unlisted cities for the same
 * reason.
 *
 * None of this is a security boundary. `resolveLocation` on the backend
 * re-checks the country/state pairing against the same catalogue this component
 * is built from.
 */

const OTHER = '__OTHER__';

export function LocationFields({ legend, value, onChange, disabled = false, issues = {}, idPrefix }) {
  const { countries, status, error } = useLocationCatalogue();

  const country = findCountry(countries, value.countryCode);
  const subdivision = findSubdivision(countries, value.countryCode, value.stateCode);

  const subdivisions = country?.subdivisions ?? [];
  // A country with no subdivisions carries its cities at the country level.
  const cities = country?.hasSubdivisions ? (subdivision?.cities ?? []) : (country?.cities ?? []);

  const stateDisabled = disabled || !value.countryCode || !country?.hasSubdivisions;
  const cityDisabled =
    disabled || !value.countryCode || (country?.hasSubdivisions && !value.stateCode);

  const stateLabel = country?.subdivisionLabel ?? 'State / Province';

  const setCountry = (countryCode) => {
    const next = findCountry(countries, countryCode);
    const keepState = next?.subdivisions.some((sub) => sub.code === value.stateCode)
      ? value.stateCode
      : '';
    // Country changed, so the state below it - and the city below that - are
    // cleared unless they still belong.
    onChange({
      ...value,
      countryCode,
      stateCode: keepState,
      city: keepState === value.stateCode ? value.city : '',
      cityIsCustom: keepState === value.stateCode ? value.cityIsCustom : false,
    });
  };

  const setState = (stateCode) => {
    const next = findSubdivision(countries, value.countryCode, stateCode);
    const keepCity = next?.cities?.includes(value.city) ? value.city : '';
    onChange({
      ...value,
      stateCode,
      city: keepCity,
      cityIsCustom: keepCity ? value.cityIsCustom : false,
    });
  };

  const setCity = (selection) => {
    if (selection === OTHER) {
      // Switch to free text, starting empty so the previous selection is not
      // mistaken for a typed value.
      onChange({ ...value, city: '', cityIsCustom: true });
      return;
    }
    onChange({ ...value, city: selection, cityIsCustom: false });
  };

  // A stored city that predates the list, or one typed via "Other", keeps the
  // manual input open rather than silently disappearing from a dropdown that
  // has no matching option.
  const usingCustomCity = value.cityIsCustom || (value.city !== '' && !cities.includes(value.city));

  return (
    <fieldset className="location-fields">
      <legend className="location-fields__legend">{legend}</legend>

      {status === 'error' ? (
        <p className="field__error" role="alert">
          The location list could not be loaded ({error?.message}). Reload the page to try again.
        </p>
      ) : null}

      <div className="form-grid form-grid--tight">
        {/* 1 — Country */}
        <label className="field">
          <span className="field__label">Country *</span>
          <select
            className="select"
            id={`${idPrefix}-country`}
            value={value.countryCode}
            onChange={(event) => setCountry(event.target.value)}
            disabled={disabled || status === 'loading'}
            aria-invalid={Boolean(issues.countryCode)}
          >
            <option value="">
              {status === 'loading' ? 'Loading countries…' : 'Select a country'}
            </option>
            {countries.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.name}
              </option>
            ))}
          </select>
          {issues.countryCode ? <span className="field__error">{issues.countryCode}</span> : null}
        </label>

        {/* 2 — State, dependent on country */}
        <label className="field">
          <span className="field__label">
            {stateLabel}
            {country?.hasSubdivisions ? ' *' : ''}
          </span>
          <select
            className="select"
            id={`${idPrefix}-state`}
            value={value.stateCode}
            onChange={(event) => setState(event.target.value)}
            disabled={stateDisabled}
            aria-invalid={Boolean(issues.stateCode)}
          >
            <option value="">
              {!value.countryCode
                ? 'Select a country first'
                : country?.hasSubdivisions
                  ? `Select a ${stateLabel.toLowerCase()}`
                  : 'Not applicable'}
            </option>
            {subdivisions.map((sub) => (
              <option key={sub.code} value={sub.code}>
                {sub.name}
              </option>
            ))}
          </select>

          {issues.stateCode ? (
            <span className="field__error">{issues.stateCode}</span>
          ) : !value.countryCode ? (
            <span className="field__hint">A state cannot be selected until a country is selected.</span>
          ) : !country?.hasSubdivisions ? (
            <span className="field__hint">{country?.name} has no separate region to select.</span>
          ) : null}
        </label>

        {/* 3 — City, dependent on state */}
        <label className="field">
          <span className="field__label">City or port *</span>
          <select
            className="select"
            id={`${idPrefix}-city`}
            value={usingCustomCity ? OTHER : value.city}
            onChange={(event) => setCity(event.target.value)}
            disabled={cityDisabled}
            aria-invalid={Boolean(issues.city)}
          >
            <option value="">
              {!value.countryCode
                ? 'Select a country first'
                : country?.hasSubdivisions && !value.stateCode
                  ? `Select a ${stateLabel.toLowerCase()} first`
                  : 'Select a city or port'}
            </option>
            {cities.map((city) => (
              <option key={city} value={city}>
                {city}
              </option>
            ))}
            {!cityDisabled ? <option value={OTHER}>Other — enter manually</option> : null}
          </select>

          {usingCustomCity && !cityDisabled ? (
            <input
              className="input location-fields__custom-city"
              id={`${idPrefix}-city-custom`}
              value={value.city}
              onChange={(event) => onChange({ ...value, city: event.target.value, cityIsCustom: true })}
              placeholder="Enter the city or port"
              disabled={disabled}
              aria-label="City or port name"
            />
          ) : null}

          {issues.city ? (
            <span className="field__error">{issues.city}</span>
          ) : usingCustomCity && !cityDisabled ? (
            <span className="field__hint">
              The list covers major ports and hubs, not every location — anything you type here is accepted.
            </span>
          ) : null}
        </label>
      </div>
    </fieldset>
  );
}
