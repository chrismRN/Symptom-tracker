// Tiny JSON-file store for daily activity totals.
//
// Shape on disk:
// {
//   "days": {
//     "2026-11-10": {
//       "steps": 8421,
//       "distance_m": 6120.4,
//       "active_kcal": 412,
//       "resting_kcal": 1630,
//       "source": "shortcut",
//       "updated_at": "2026-11-10T23:55:02.118Z"
//     }
//   },
//   "last_sync": "2026-11-10T23:55:02.118Z"
// }
//
// Values are daily totals. A newer upload for the same day replaces the
// fields it sends (the iPhone Shortcut sends running totals for "today").

import fs from 'node:fs';
import path from 'node:path';

export const METRIC_FIELDS = ['steps', 'distance_m', 'active_kcal', 'resting_kcal'];

export class HealthStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.data = { days: {}, last_sync: null };
    this.#load();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.days) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Re-read the file (used by the stdio server so it sees new imports). */
  reload() {
    this.#load();
  }

  /**
   * Merge daily totals into the store.
   * @param {Array<{date: string} & Partial<Record<string, number>>>} days
   * @param {{source?: string, overwrite?: boolean}} opts
   *   overwrite=false only fills fields that are currently empty.
   * @returns {number} how many days were touched
   */
  upsertDays(days, { source = 'shortcut', overwrite = true } = {}) {
    const now = new Date().toISOString();
    let touched = 0;
    for (const day of days) {
      const existing = this.data.days[day.date] || {};
      const next = { ...existing };
      let changed = false;
      for (const field of METRIC_FIELDS) {
        if (day[field] === undefined || day[field] === null) continue;
        if (!overwrite && existing[field] !== undefined && existing[field] !== null) continue;
        next[field] = day[field];
        changed = true;
      }
      if (!changed) continue;
      next.source = source;
      next.updated_at = now;
      this.data.days[day.date] = next;
      touched++;
    }
    if (touched > 0) {
      if (source === 'shortcut') this.data.last_sync = now;
      this.#save();
    }
    return touched;
  }

  getDay(date) {
    return this.data.days[date] || null;
  }

  /** Inclusive date range; both dates are YYYY-MM-DD strings. */
  getRange(start, end) {
    return Object.keys(this.data.days)
      .filter((d) => d >= start && d <= end)
      .sort()
      .map((date) => ({ date, ...this.data.days[date] }));
  }

  status() {
    const dates = Object.keys(this.data.days).sort();
    return {
      last_sync: this.data.last_sync,
      days_on_file: dates.length,
      earliest_date: dates[0] || null,
      latest_date: dates[dates.length - 1] || null,
    };
  }
}
