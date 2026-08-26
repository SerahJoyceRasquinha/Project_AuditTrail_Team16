/**
 * Country / subdivision reference data - the single source of truth.
 *
 * Why this file exists at all
 * --------------------------
 * Origin and destination used to be free text, which is a problem for an audit
 * ledger specifically: "Chennai, IN", "chennai india" and "Chennai, Tamil Nadu"
 * are the same place to a human and three different places to a query. A
 * dispute about where a container was cannot be settled against inconsistent
 * strings.
 *
 * The list lives in the **domain layer**, not in a React component, for three
 * reasons:
 *
 *   1. the backend has to validate the country/state pairing itself - a client
 *      that skips the dropdown and POSTs directly must be rejected;
 *   2. the frontend fetches the identical list from `GET /api/meta/locations`,
 *      so the dropdown and the validator can never disagree;
 *   3. adding a country is one edit here rather than one edit per UI component.
 *
 * Codes are ISO 3166-1 alpha-2 for countries and the subdivision part of ISO
 * 3166-2 for states/provinces. Storing codes rather than display names is what
 * makes the stored payload stable: a country renaming its capital or a UI
 * changing its label does not rewrite history.
 *
 * Countries whose subdivisions are not meaningful for a shipping address (city
 * states, small territories) carry an empty `subdivisions` array. That is a
 * deliberate, checkable statement - "this country has no state to select" -
 * rather than an accidental omission, and the validators treat it as such.
 */

import { citiesFor, isKnownCity } from './cities.js';

/** @typedef {{code: string, name: string}} Subdivision */

const COUNTRY_LIST = [
  {
    code: 'AE',
    name: 'United Arab Emirates',
    subdivisionLabel: 'Emirate',
    subdivisions: [
      ['AJ', 'Ajman'],
      ['AZ', 'Abu Dhabi'],
      ['DU', 'Dubai'],
      ['FU', 'Fujairah'],
      ['RK', 'Ras Al Khaimah'],
      ['SH', 'Sharjah'],
      ['UQ', 'Umm Al Quwain'],
    ],
  },
  {
    code: 'AR',
    name: 'Argentina',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['B', 'Buenos Aires'],
      ['C', 'Ciudad Autónoma de Buenos Aires'],
      ['S', 'Santa Fe'],
      ['X', 'Córdoba'],
      ['M', 'Mendoza'],
      ['E', 'Entre Ríos'],
    ],
  },
  {
    code: 'AU',
    name: 'Australia',
    subdivisionLabel: 'State / Territory',
    subdivisions: [
      ['ACT', 'Australian Capital Territory'],
      ['NSW', 'New South Wales'],
      ['NT', 'Northern Territory'],
      ['QLD', 'Queensland'],
      ['SA', 'South Australia'],
      ['TAS', 'Tasmania'],
      ['VIC', 'Victoria'],
      ['WA', 'Western Australia'],
    ],
  },
  {
    code: 'BE',
    name: 'Belgium',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['VAN', 'Antwerp'],
      ['VOV', 'East Flanders'],
      ['VWV', 'West Flanders'],
      ['VBR', 'Flemish Brabant'],
      ['VLI', 'Limburg'],
      ['WHT', 'Hainaut'],
      ['WLG', 'Liège'],
      ['BRU', 'Brussels-Capital'],
    ],
  },
  {
    code: 'BR',
    name: 'Brazil',
    subdivisionLabel: 'State',
    subdivisions: [
      ['AM', 'Amazonas'],
      ['BA', 'Bahia'],
      ['CE', 'Ceará'],
      ['ES', 'Espírito Santo'],
      ['GO', 'Goiás'],
      ['MG', 'Minas Gerais'],
      ['PA', 'Pará'],
      ['PE', 'Pernambuco'],
      ['PR', 'Paraná'],
      ['RJ', 'Rio de Janeiro'],
      ['RS', 'Rio Grande do Sul'],
      ['SC', 'Santa Catarina'],
      ['SP', 'São Paulo'],
    ],
  },
  {
    code: 'CA',
    name: 'Canada',
    subdivisionLabel: 'Province / Territory',
    subdivisions: [
      ['AB', 'Alberta'],
      ['BC', 'British Columbia'],
      ['MB', 'Manitoba'],
      ['NB', 'New Brunswick'],
      ['NL', 'Newfoundland and Labrador'],
      ['NS', 'Nova Scotia'],
      ['NT', 'Northwest Territories'],
      ['NU', 'Nunavut'],
      ['ON', 'Ontario'],
      ['PE', 'Prince Edward Island'],
      ['QC', 'Quebec'],
      ['SK', 'Saskatchewan'],
      ['YT', 'Yukon'],
    ],
  },
  {
    code: 'CN',
    name: 'China',
    subdivisionLabel: 'Province / Municipality',
    subdivisions: [
      ['AH', 'Anhui'],
      ['BJ', 'Beijing'],
      ['CQ', 'Chongqing'],
      ['FJ', 'Fujian'],
      ['GD', 'Guangdong'],
      ['HB', 'Hubei'],
      ['HE', 'Hebei'],
      ['HI', 'Hainan'],
      ['JS', 'Jiangsu'],
      ['LN', 'Liaoning'],
      ['SD', 'Shandong'],
      ['SH', 'Shanghai'],
      ['TJ', 'Tianjin'],
      ['ZJ', 'Zhejiang'],
    ],
  },
  {
    code: 'DE',
    name: 'Germany',
    subdivisionLabel: 'State',
    subdivisions: [
      ['BW', 'Baden-Württemberg'],
      ['BY', 'Bavaria'],
      ['BE', 'Berlin'],
      ['BB', 'Brandenburg'],
      ['HB', 'Bremen'],
      ['HH', 'Hamburg'],
      ['HE', 'Hesse'],
      ['MV', 'Mecklenburg-Vorpommern'],
      ['NI', 'Lower Saxony'],
      ['NW', 'North Rhine-Westphalia'],
      ['RP', 'Rhineland-Palatinate'],
      ['SL', 'Saarland'],
      ['SN', 'Saxony'],
      ['ST', 'Saxony-Anhalt'],
      ['SH', 'Schleswig-Holstein'],
      ['TH', 'Thuringia'],
    ],
  },
  {
    code: 'DK',
    name: 'Denmark',
    subdivisionLabel: 'Region',
    subdivisions: [
      ['84', 'Capital Region'],
      ['82', 'Central Denmark'],
      ['81', 'North Denmark'],
      ['85', 'Zealand'],
      ['83', 'Southern Denmark'],
    ],
  },
  {
    code: 'EG',
    name: 'Egypt',
    subdivisionLabel: 'Governorate',
    subdivisions: [
      ['ALX', 'Alexandria'],
      ['C', 'Cairo'],
      ['DT', 'Damietta'],
      ['PTS', 'Port Said'],
      ['SUZ', 'Suez'],
      ['IS', 'Ismailia'],
    ],
  },
  {
    code: 'ES',
    name: 'Spain',
    subdivisionLabel: 'Autonomous Community',
    subdivisions: [
      ['AN', 'Andalusia'],
      ['AR', 'Aragon'],
      ['AS', 'Asturias'],
      ['CN', 'Canary Islands'],
      ['CT', 'Catalonia'],
      ['GA', 'Galicia'],
      ['MD', 'Madrid'],
      ['MC', 'Murcia'],
      ['PV', 'Basque Country'],
      ['VC', 'Valencian Community'],
    ],
  },
  {
    code: 'FR',
    name: 'France',
    subdivisionLabel: 'Region',
    subdivisions: [
      ['ARA', 'Auvergne-Rhône-Alpes'],
      ['BFC', 'Bourgogne-Franche-Comté'],
      ['BRE', 'Brittany'],
      ['CVL', 'Centre-Val de Loire'],
      ['GES', 'Grand Est'],
      ['HDF', 'Hauts-de-France'],
      ['IDF', 'Île-de-France'],
      ['NOR', 'Normandy'],
      ['NAQ', 'Nouvelle-Aquitaine'],
      ['OCC', 'Occitanie'],
      ['PDL', 'Pays de la Loire'],
      ["PAC", "Provence-Alpes-Côte d'Azur"],
    ],
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    subdivisionLabel: 'Country / Region',
    subdivisions: [
      ['ENG', 'England'],
      ['NIR', 'Northern Ireland'],
      ['SCT', 'Scotland'],
      ['WLS', 'Wales'],
    ],
  },
  {
    code: 'GR',
    name: 'Greece',
    subdivisionLabel: 'Region',
    subdivisions: [
      ['A', 'Attica'],
      ['B', 'Central Macedonia'],
      ['M', 'Crete'],
      ['L', 'South Aegean'],
      ['K', 'North Aegean'],
    ],
  },
  {
    code: 'HK',
    name: 'Hong Kong SAR',
    subdivisionLabel: 'District',
    subdivisions: [],
  },
  {
    code: 'ID',
    name: 'Indonesia',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['JK', 'Jakarta'],
      ['JB', 'West Java'],
      ['JI', 'East Java'],
      ['JT', 'Central Java'],
      ['SU', 'North Sumatra'],
      ['KI', 'East Kalimantan'],
      ['BA', 'Bali'],
    ],
  },
  {
    code: 'IE',
    name: 'Ireland',
    subdivisionLabel: 'County',
    subdivisions: [
      ['C', 'Cork'],
      ['D', 'Dublin'],
      ['G', 'Galway'],
      ['LK', 'Limerick'],
      ['WD', 'Waterford'],
    ],
  },
  {
    code: 'IN',
    name: 'India',
    subdivisionLabel: 'State / Union Territory',
    subdivisions: [
      ['AN', 'Andaman and Nicobar Islands'],
      ['AP', 'Andhra Pradesh'],
      ['AR', 'Arunachal Pradesh'],
      ['AS', 'Assam'],
      ['BR', 'Bihar'],
      ['CH', 'Chandigarh'],
      ['CT', 'Chhattisgarh'],
      ['DH', 'Dadra and Nagar Haveli and Daman and Diu'],
      ['DL', 'Delhi'],
      ['GA', 'Goa'],
      ['GJ', 'Gujarat'],
      ['HR', 'Haryana'],
      ['HP', 'Himachal Pradesh'],
      ['JK', 'Jammu and Kashmir'],
      ['JH', 'Jharkhand'],
      ['KA', 'Karnataka'],
      ['KL', 'Kerala'],
      ['LA', 'Ladakh'],
      ['LD', 'Lakshadweep'],
      ['MP', 'Madhya Pradesh'],
      ['MH', 'Maharashtra'],
      ['MN', 'Manipur'],
      ['ML', 'Meghalaya'],
      ['MZ', 'Mizoram'],
      ['NL', 'Nagaland'],
      ['OR', 'Odisha'],
      ['PY', 'Puducherry'],
      ['PB', 'Punjab'],
      ['RJ', 'Rajasthan'],
      ['SK', 'Sikkim'],
      ['TN', 'Tamil Nadu'],
      ['TG', 'Telangana'],
      ['TR', 'Tripura'],
      ['UP', 'Uttar Pradesh'],
      ['UT', 'Uttarakhand'],
      ['WB', 'West Bengal'],
    ],
  },
  {
    code: 'IT',
    name: 'Italy',
    subdivisionLabel: 'Region',
    subdivisions: [
      ['21', 'Piedmont'],
      ['25', 'Lombardy'],
      ['34', 'Veneto'],
      ['36', 'Friuli-Venezia Giulia'],
      ['42', 'Liguria'],
      ['45', 'Emilia-Romagna'],
      ['52', 'Tuscany'],
      ['62', 'Lazio'],
      ['72', 'Campania'],
      ['75', 'Apulia'],
      ['82', 'Sicily'],
      ['88', 'Sardinia'],
    ],
  },
  {
    code: 'JP',
    name: 'Japan',
    subdivisionLabel: 'Prefecture',
    subdivisions: [
      ['01', 'Hokkaido'],
      ['13', 'Tokyo'],
      ['14', 'Kanagawa'],
      ['23', 'Aichi'],
      ['27', 'Osaka'],
      ['28', 'Hyogo'],
      ['33', 'Okayama'],
      ['40', 'Fukuoka'],
    ],
  },
  {
    code: 'KE',
    name: 'Kenya',
    subdivisionLabel: 'County',
    subdivisions: [
      ['30', 'Mombasa'],
      ['47', 'Nairobi'],
      ['28', 'Kilifi'],
      ['32', 'Nakuru'],
    ],
  },
  {
    code: 'KR',
    name: 'South Korea',
    subdivisionLabel: 'Province / Metropolitan City',
    subdivisions: [
      ['11', 'Seoul'],
      ['26', 'Busan'],
      ['28', 'Incheon'],
      ['31', 'Ulsan'],
      ['41', 'Gyeonggi'],
      ['48', 'South Gyeongsang'],
    ],
  },
  {
    code: 'LK',
    name: 'Sri Lanka',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['1', 'Western'],
      ['2', 'Central'],
      ['3', 'Southern'],
      ['5', 'Eastern'],
      ['6', 'North Western'],
    ],
  },
  {
    code: 'MA',
    name: 'Morocco',
    subdivisionLabel: 'Region',
    subdivisions: [
      ['01', 'Tanger-Tetouan-Al Hoceima'],
      ['06', 'Casablanca-Settat'],
      ['09', 'Souss-Massa'],
      ['04', "Rabat-Salé-Kénitra"],
    ],
  },
  {
    code: 'MX',
    name: 'Mexico',
    subdivisionLabel: 'State',
    subdivisions: [
      ['BCN', 'Baja California'],
      ['CMX', 'Mexico City'],
      ['JAL', 'Jalisco'],
      ['MIC', 'Michoacán'],
      ['NLE', 'Nuevo León'],
      ['QUE', 'Querétaro'],
      ['SIN', 'Sinaloa'],
      ['TAM', 'Tamaulipas'],
      ['VER', 'Veracruz'],
      ['YUC', 'Yucatán'],
    ],
  },
  {
    code: 'MY',
    name: 'Malaysia',
    subdivisionLabel: 'State',
    subdivisions: [
      ['01', 'Johor'],
      ['07', 'Penang'],
      ['08', 'Perak'],
      ['10', 'Selangor'],
      ['12', 'Sabah'],
      ['13', 'Sarawak'],
      ['14', 'Kuala Lumpur'],
    ],
  },
  {
    code: 'NG',
    name: 'Nigeria',
    subdivisionLabel: 'State',
    subdivisions: [
      ['LA', 'Lagos'],
      ['RI', 'Rivers'],
      ['FC', 'Federal Capital Territory'],
      ['KN', 'Kano'],
    ],
  },
  {
    code: 'NL',
    name: 'Netherlands',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['DR', 'Drenthe'],
      ['FL', 'Flevoland'],
      ['FR', 'Friesland'],
      ['GE', 'Gelderland'],
      ['GR', 'Groningen'],
      ['LI', 'Limburg'],
      ['NB', 'North Brabant'],
      ['NH', 'North Holland'],
      ['OV', 'Overijssel'],
      ['UT', 'Utrecht'],
      ['ZE', 'Zeeland'],
      ['ZH', 'South Holland'],
    ],
  },
  {
    code: 'NO',
    name: 'Norway',
    subdivisionLabel: 'County',
    subdivisions: [
      ['03', 'Oslo'],
      ['11', 'Rogaland'],
      ['46', 'Vestland'],
      ['50', 'Trøndelag'],
      ['15', 'Møre og Romsdal'],
    ],
  },
  {
    code: 'NZ',
    name: 'New Zealand',
    subdivisionLabel: 'Region',
    subdivisions: [
      ['AUK', 'Auckland'],
      ['CAN', 'Canterbury'],
      ['WGN', 'Wellington'],
      ['BOP', 'Bay of Plenty'],
      ['OTA', 'Otago'],
    ],
  },
  {
    code: 'OM',
    name: 'Oman',
    subdivisionLabel: 'Governorate',
    subdivisions: [
      ['MA', 'Muscat'],
      ['ZU', 'Dhofar'],
      ['BS', 'North Al Batinah'],
      ['BJ', 'South Al Batinah'],
    ],
  },
  {
    code: 'PA',
    name: 'Panama',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['8', 'Panamá'],
      ['3', 'Colón'],
      ['4', 'Chiriquí'],
    ],
  },
  {
    code: 'PH',
    name: 'Philippines',
    subdivisionLabel: 'Region',
    subdivisions: [
      ['00', 'National Capital Region'],
      ['07', 'Central Visayas'],
      ['11', 'Davao Region'],
      ['03', 'Central Luzon'],
      ['04', 'Calabarzon'],
    ],
  },
  {
    code: 'PL',
    name: 'Poland',
    subdivisionLabel: 'Voivodeship',
    subdivisions: [
      ['22', 'Pomeranian'],
      ['32', 'West Pomeranian'],
      ['14', 'Masovian'],
      ['12', 'Lesser Poland'],
      ['02', 'Lower Silesian'],
    ],
  },
  {
    code: 'PT',
    name: 'Portugal',
    subdivisionLabel: 'District',
    subdivisions: [
      ['11', 'Lisbon'],
      ['13', 'Porto'],
      ['08', 'Faro'],
      ['16', 'Viana do Castelo'],
    ],
  },
  {
    code: 'QA',
    name: 'Qatar',
    subdivisionLabel: 'Municipality',
    subdivisions: [
      ['DA', 'Doha'],
      ['RA', 'Al Rayyan'],
      ['MS', 'Al Shamal'],
    ],
  },
  {
    code: 'SA',
    name: 'Saudi Arabia',
    subdivisionLabel: 'Region',
    subdivisions: [
      ['01', 'Riyadh'],
      ['02', 'Makkah'],
      ['04', 'Eastern Province'],
      ['03', 'Madinah'],
      ['14', 'Asir'],
    ],
  },
  {
    code: 'SE',
    name: 'Sweden',
    subdivisionLabel: 'County',
    subdivisions: [
      ['AB', 'Stockholm'],
      ['O', 'Västra Götaland'],
      ['M', 'Skåne'],
      ['E', 'Östergötland'],
    ],
  },
  {
    code: 'SG',
    name: 'Singapore',
    subdivisionLabel: 'Region',
    subdivisions: [],
  },
  {
    code: 'TH',
    name: 'Thailand',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['10', 'Bangkok'],
      ['20', 'Chonburi'],
      ['83', 'Phuket'],
      ['90', 'Songkhla'],
      ['50', 'Chiang Mai'],
    ],
  },
  {
    code: 'TR',
    name: 'Türkiye',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['34', 'Istanbul'],
      ['35', 'Izmir'],
      ['01', 'Adana'],
      ['33', 'Mersin'],
      ['16', 'Bursa'],
    ],
  },
  {
    code: 'US',
    name: 'United States',
    subdivisionLabel: 'State',
    subdivisions: [
      ['AL', 'Alabama'],
      ['AK', 'Alaska'],
      ['AZ', 'Arizona'],
      ['AR', 'Arkansas'],
      ['CA', 'California'],
      ['CO', 'Colorado'],
      ['CT', 'Connecticut'],
      ['DE', 'Delaware'],
      ['DC', 'District of Columbia'],
      ['FL', 'Florida'],
      ['GA', 'Georgia'],
      ['HI', 'Hawaii'],
      ['ID', 'Idaho'],
      ['IL', 'Illinois'],
      ['IN', 'Indiana'],
      ['IA', 'Iowa'],
      ['KS', 'Kansas'],
      ['KY', 'Kentucky'],
      ['LA', 'Louisiana'],
      ['ME', 'Maine'],
      ['MD', 'Maryland'],
      ['MA', 'Massachusetts'],
      ['MI', 'Michigan'],
      ['MN', 'Minnesota'],
      ['MS', 'Mississippi'],
      ['MO', 'Missouri'],
      ['MT', 'Montana'],
      ['NE', 'Nebraska'],
      ['NV', 'Nevada'],
      ['NH', 'New Hampshire'],
      ['NJ', 'New Jersey'],
      ['NM', 'New Mexico'],
      ['NY', 'New York'],
      ['NC', 'North Carolina'],
      ['ND', 'North Dakota'],
      ['OH', 'Ohio'],
      ['OK', 'Oklahoma'],
      ['OR', 'Oregon'],
      ['PA', 'Pennsylvania'],
      ['PR', 'Puerto Rico'],
      ['RI', 'Rhode Island'],
      ['SC', 'South Carolina'],
      ['SD', 'South Dakota'],
      ['TN', 'Tennessee'],
      ['TX', 'Texas'],
      ['UT', 'Utah'],
      ['VT', 'Vermont'],
      ['VA', 'Virginia'],
      ['WA', 'Washington'],
      ['WV', 'West Virginia'],
      ['WI', 'Wisconsin'],
      ['WY', 'Wyoming'],
    ],
  },
  {
    code: 'VN',
    name: 'Vietnam',
    subdivisionLabel: 'Province / Municipality',
    subdivisions: [
      ['HN', 'Hanoi'],
      ['SG', 'Ho Chi Minh City'],
      ['DN', 'Da Nang'],
      ['HP', 'Haiphong'],
      ['BR', 'Ba Ria-Vung Tau'],
    ],
  },
  {
    code: 'ZA',
    name: 'South Africa',
    subdivisionLabel: 'Province',
    subdivisions: [
      ['EC', 'Eastern Cape'],
      ['FS', 'Free State'],
      ['GP', 'Gauteng'],
      ['KZN', 'KwaZulu-Natal'],
      ['LP', 'Limpopo'],
      ['MP', 'Mpumalanga'],
      ['NC', 'Northern Cape'],
      ['NW', 'North West'],
      ['WC', 'Western Cape'],
    ],
  },
];

/** Normalised, frozen catalogue keyed by country code. */
export const COUNTRIES = Object.freeze(
  COUNTRY_LIST.map((country) =>
    Object.freeze({
      code: country.code,
      name: country.name,
      subdivisionLabel: country.subdivisionLabel ?? 'State / Province',
      hasSubdivisions: country.subdivisions.length > 0,
      subdivisions: Object.freeze(
        country.subdivisions
          .map(([code, name]) => Object.freeze({ code, name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      ),
    })
  ).sort((a, b) => a.name.localeCompare(b.name))
);

const BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]));

export const COUNTRY_CODES = Object.freeze(COUNTRIES.map((country) => country.code));

export function findCountry(countryCode) {
  if (typeof countryCode !== 'string') return null;
  return BY_CODE.get(countryCode.trim().toUpperCase()) ?? null;
}

export function findSubdivision(countryCode, stateCode) {
  const country = findCountry(countryCode);
  if (!country || typeof stateCode !== 'string') return null;
  const wanted = stateCode.trim().toUpperCase();
  return country.subdivisions.find((sub) => sub.code.toUpperCase() === wanted) ?? null;
}

/**
 * Builds the display string stored alongside the codes.
 *
 * The ledger keeps *both*: codes because they are stable and queryable, and
 * this human string because an auditor reading a PDF three years from now
 * should not have to look up what "IN-TN" meant. Deriving it here - in one
 * place, at write time - is what stops two screens rendering the same location
 * differently.
 */
export function formatLocation({ city, stateName, countryName }) {
  return [city, stateName, countryName].filter((part) => part && String(part).trim() !== '').join(', ');
}

/**
 * Resolves a raw `{ city, countryCode, stateCode }` input into the normalised
 * location object that goes into the event payload.
 *
 * Returns `{ location, issues }`. It never throws: callers collect issues from
 * several fields and report them together, which is what lets a form show every
 * problem in one round trip instead of one per submit.
 *
 * The rules, in the order the requirements state them:
 *
 *   - a state can never be resolved without a country (`STATE_WITHOUT_COUNTRY`);
 *   - a state must belong to the country given (`STATE_NOT_IN_COUNTRY`);
 *   - a country that *has* subdivisions requires one to be chosen;
 *   - a country with no subdivisions must not be sent one.
 */
export function resolveLocation(input, { fieldPrefix = 'location' } = {}) {
  const issues = [];
  const city = typeof input?.city === 'string' ? input.city.trim() : '';
  const rawCountry = typeof input?.countryCode === 'string' ? input.countryCode.trim() : '';
  const rawState = typeof input?.stateCode === 'string' ? input.stateCode.trim() : '';

  if (rawCountry === '') {
    issues.push({
      field: `${fieldPrefix}.countryCode`,
      code: 'COUNTRY_REQUIRED',
      message: 'Select a country.',
    });
    if (rawState !== '') {
      issues.push({
        field: `${fieldPrefix}.stateCode`,
        code: 'STATE_WITHOUT_COUNTRY',
        message: 'A state cannot be selected until a country is selected.',
      });
    }
    return { location: null, issues };
  }

  const country = findCountry(rawCountry);
  if (!country) {
    issues.push({
      field: `${fieldPrefix}.countryCode`,
      code: 'UNKNOWN_COUNTRY',
      message: `'${rawCountry}' is not a country this system recognises.`,
    });
    return { location: null, issues };
  }

  let subdivision = null;
  if (country.hasSubdivisions) {
    if (rawState === '') {
      issues.push({
        field: `${fieldPrefix}.stateCode`,
        code: 'STATE_REQUIRED',
        message: `Select a ${country.subdivisionLabel.toLowerCase()} in ${country.name}.`,
      });
    } else {
      subdivision = findSubdivision(country.code, rawState);
      if (!subdivision) {
        issues.push({
          field: `${fieldPrefix}.stateCode`,
          code: 'STATE_NOT_IN_COUNTRY',
          message: `The selected state does not belong to ${country.name}.`,
        });
      }
    }
  } else if (rawState !== '') {
    issues.push({
      field: `${fieldPrefix}.stateCode`,
      code: 'STATE_NOT_IN_COUNTRY',
      message: `${country.name} has no selectable ${country.subdivisionLabel.toLowerCase()}.`,
    });
  }

  if (city.length > 120) {
    issues.push({
      field: `${fieldPrefix}.city`,
      code: 'CITY_TOO_LONG',
      message: 'The city or port name must be at most 120 characters.',
    });
  }

  if (issues.length > 0) return { location: null, issues };

  return {
    location: Object.freeze({
      city: city || null,
      /**
       * Whether the city came from the curated list.
       *
       * Recorded, not enforced. Cities have no ISO registry, so this list is a
       * curated subset rather than a closed set - refusing an unlisted port
       * would block a legitimate shipment because a data file was incomplete.
       * The flag lets the report say how the value was entered without the
       * validator pretending to an authority it does not have.
       */
      cityFromCatalogue: city ? isKnownCity(country.code, subdivision?.code ?? '', city) : false,
      countryCode: country.code,
      countryName: country.name,
      stateCode: subdivision?.code ?? null,
      stateName: subdivision?.name ?? null,
      display: formatLocation({
        city,
        stateName: subdivision?.name ?? null,
        countryName: country.name,
      }),
    }),
    issues: [],
  };
}

/** The payload served by `GET /api/meta/locations`, shaped for a dropdown. */
export function locationCatalogue() {
  return {
    countries: COUNTRIES.map((country) => ({
      code: country.code,
      name: country.name,
      subdivisionLabel: country.subdivisionLabel,
      hasSubdivisions: country.hasSubdivisions,
      subdivisions: country.subdivisions.map((sub) => ({
        code: sub.code,
        name: sub.name,
        // Suggestions for the third dropdown. Sent with the catalogue rather
        // than fetched per selection: the whole payload is a few hundred
        // kilobytes, cached for a day, and this keeps the city list instant
        // when the user changes state.
        cities: citiesFor(country.code, sub.code),
      })),
      cities: country.hasSubdivisions ? [] : citiesFor(country.code, ''),
    })),
    generatedAt: new Date().toISOString(),
    note: 'Country codes are ISO 3166-1 alpha-2; subdivision codes follow ISO 3166-2. A country with an empty subdivision list has no selectable state. City lists are curated suggestions - they are not exhaustive, and an unlisted city is accepted.',
  };
}
