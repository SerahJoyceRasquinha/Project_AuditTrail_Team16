import { useEffect, useState } from 'react';
import * as api from '../services/apiClient.js';

/**
 * The country/subdivision catalogue, fetched from the backend rather than
 * bundled into a component.
 *
 * The requirement asks for a maintainable data source instead of large lists
 * hardcoded in individual UI components, and there is a correctness argument on
 * top of the maintenance one: the backend validates every country/state pair
 * against its own copy. If this file carried a second copy, the two would
 * eventually disagree, and the dropdown would start offering combinations the
 * server refuses. Fetching the same catalogue the validator uses makes that
 * class of bug impossible.
 *
 * The response is cached in module scope for the session - it is served with a
 * day-long cache header and changes about as often as the map does, so there is
 * no reason for a second request when the user opens the form again.
 */

let cache = null;
let inFlight = null;

export async function loadLocationCatalogue() {
  if (cache) return cache;
  if (!inFlight) {
    inFlight = api
      .getLocationCatalogue()
      .then((data) => {
        cache = data;
        inFlight = null;
        return data;
      })
      .catch((error) => {
        inFlight = null;
        throw error;
      });
  }
  return inFlight;
}

/** Exposed for tests, which must not inherit another test's cache. */
export function resetLocationCache() {
  cache = null;
  inFlight = null;
}

export function useLocationCatalogue() {
  const [state, setState] = useState({
    status: cache ? 'success' : 'loading',
    countries: cache?.countries ?? [],
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (cache) {
      setState({ status: 'success', countries: cache.countries, error: null });
      return () => {
        cancelled = true;
      };
    }

    loadLocationCatalogue()
      .then((data) => {
        if (!cancelled) setState({ status: 'success', countries: data.countries, error: null });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', countries: [], error });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export const findCountry = (countries, code) =>
  countries.find((country) => country.code === code) ?? null;

/** The subdivision object, which carries its own curated city list. */
export const findSubdivision = (countries, countryCode, stateCode) =>
  findCountry(countries, countryCode)?.subdivisions.find((sub) => sub.code === stateCode) ?? null;

/**
 * Curated city suggestions for a country/state pair.
 *
 * An empty result means "no suggestions", never "no valid cities" - the UI
 * offers manual entry and the backend accepts it.
 */
export function citiesFor(countries, countryCode, stateCode) {
  const country = findCountry(countries, countryCode);
  if (!country) return [];
  if (!country.hasSubdivisions) return country.cities ?? [];
  return findSubdivision(countries, countryCode, stateCode)?.cities ?? [];
}

/**
 * Whether a state code is valid for a country.
 *
 * Used to decide whether a previously chosen state survives a country change.
 * It answers "does this still belong?" rather than "has the country changed?",
 * which matters for the edge case where a form is reopened with stored values.
 */
export function isSubdivisionOf(countries, countryCode, stateCode) {
  const country = findCountry(countries, countryCode);
  if (!country) return false;
  if (!country.hasSubdivisions) return !stateCode;
  return country.subdivisions.some((sub) => sub.code === stateCode);
}

/** The same display string the backend builds, so the UI and the ledger agree. */
export function formatLocationDisplay(countries, { city, countryCode, stateCode }) {
  const country = findCountry(countries, countryCode);
  if (!country) return city ?? '';
  const state = country.subdivisions.find((sub) => sub.code === stateCode);
  return [city, state?.name, country.name].filter(Boolean).join(', ');
}
