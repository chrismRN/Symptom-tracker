// Turns whatever the iPhone Shortcut sends into clean daily totals.
//
// iOS Shortcuts is loose about types: numbers may arrive as strings with
// thousands separators ("8,421") or with units attached ("3.2 mi", "412 kcal").
// Everything here is defensive about that.

export const METERS_PER = { m: 1, km: 1000, mi: 1609.344, ft: 0.3048, yd: 0.9144 };
const KCAL_PER = { kcal: 1, cal: 1, kj: 1 / 4.184 }; // "Cal" in Health == kcal

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Today's date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(timeZone) {
  return dateIn(new Date(), timeZone);
}

export function dateIn(d, timeZone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isValidDate(s) {
  const m = DATE_RE.exec(s || '');
  if (!m || s.length !== 10) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function normalizeDate(value, timeZone) {
  if (value === undefined || value === null || value === '') return todayIn(timeZone);
  const s = String(value).trim();
  const m = DATE_RE.exec(s);
  if (m && isValidDate(m[0])) return m[0];
  throw new Error(`Unrecognised date "${s}". Send it as YYYY-MM-DD (Format Date → ISO 8601 in Shortcuts).`);
}

/**
 * Parse "8,421", "3.2 mi", 412 → { value, unit }.
 * Returns null for empty input.
 */
export function parseQuantity(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`Not a number: ${input}`);
    return { value: input, unit: null };
  }
  const s = String(input).trim().replace(/,/g, '');
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/.exec(s);
  if (!m) throw new Error(`Could not read a number from "${input}"`);
  return { value: Number(m[1]), unit: m[2] ? m[2].toLowerCase() : null };
}

function unitKey(u) {
  if (!u) return null;
  const x = u.toLowerCase();
  if (['mi', 'mile', 'miles'].includes(x)) return 'mi';
  if (['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'].includes(x)) return 'km';
  if (['m', 'meter', 'meters', 'metre', 'metres'].includes(x)) return 'm';
  if (['ft', 'foot', 'feet'].includes(x)) return 'ft';
  if (['yd', 'yard', 'yards'].includes(x)) return 'yd';
  if (['kcal', 'cal', 'cals', 'calorie', 'calories'].includes(x)) return 'kcal';
  if (['kj', 'kilojoule', 'kilojoules'].includes(x)) return 'kj';
  return x;
}

function toMeters(raw, fallbackUnit) {
  const q = parseQuantity(raw);
  if (!q) return undefined;
  const unit = unitKey(q.unit) || unitKey(fallbackUnit) || 'mi';
  const factor = METERS_PER[unit];
  if (!factor) throw new Error(`Unknown distance unit "${q.unit || fallbackUnit}"`);
  return nonNegative(q.value * factor, 'distance');
}

function toKcal(raw, fallbackUnit) {
  const q = parseQuantity(raw);
  if (!q) return undefined;
  const unit = unitKey(q.unit) || unitKey(fallbackUnit) || 'kcal';
  const factor = KCAL_PER[unit];
  if (!factor) throw new Error(`Unknown energy unit "${q.unit || fallbackUnit}"`);
  return nonNegative(q.value * factor, 'calories');
}

function nonNegative(v, label) {
  if (v < 0) throw new Error(`${label} cannot be negative`);
  return Math.round(v * 10) / 10;
}

/** Normalise one day object from the Shortcut. */
export function normalizeDay(input, { timeZone } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Each day must be a JSON object');
  const day = { date: normalizeDate(input.date, timeZone) };

  const steps = parseQuantity(input.steps);
  if (steps) day.steps = Math.round(nonNegative(steps.value, 'steps'));

  // Distance: accept distance_mi / distance_km / distance_m, or distance + distance_unit.
  if (input.distance_mi !== undefined) day.distance_m = toMeters(input.distance_mi, 'mi');
  else if (input.distance_km !== undefined) day.distance_m = toMeters(input.distance_km, 'km');
  else if (input.distance_m !== undefined) day.distance_m = toMeters(input.distance_m, 'm');
  else if (input.distance !== undefined) day.distance_m = toMeters(input.distance, input.distance_unit);

  const active = input.active_calories ?? input.active_kcal ?? input.active_energy;
  const resting = input.resting_calories ?? input.resting_kcal ?? input.resting_energy ?? input.basal_energy;
  if (active !== undefined) day.active_kcal = toKcal(active, input.energy_unit);
  if (resting !== undefined) day.resting_kcal = toKcal(resting, input.energy_unit);

  for (const k of Object.keys(day)) if (day[k] === undefined) delete day[k];
  if (Object.keys(day).length === 1) {
    throw new Error('No metrics found. Send at least one of: steps, distance, active_calories, resting_calories.');
  }
  return day;
}

/** Accepts a single day object, an array of days, or { days: [...] }. */
export function normalizePayload(body, opts = {}) {
  let list;
  if (Array.isArray(body)) list = body;
  else if (body && Array.isArray(body.days)) list = body.days;
  else list = [body];
  if (list.length === 0) throw new Error('No days in payload');
  if (list.length > 400) throw new Error('Too many days in one upload (max 400)');
  return list.map((d) => normalizeDay(d, opts));
}

/** Converts a stored day into the user-facing shape Claude sees. */
export function presentDay(date, rec) {
  const r = rec || {};
  const miles = r.distance_m != null ? round(r.distance_m / METERS_PER.mi, 2) : null;
  const km = r.distance_m != null ? round(r.distance_m / 1000, 2) : null;
  const active = r.active_kcal ?? null;
  const resting = r.resting_kcal ?? null;
  return {
    date,
    steps: r.steps ?? null,
    distance_miles: miles,
    distance_km: km,
    active_calories: active,
    resting_calories: resting,
    total_calories: active != null && resting != null ? round(active + resting, 0) : null,
    last_updated: r.updated_at ?? null,
  };
}

export function round(v, places) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
