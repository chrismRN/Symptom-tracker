import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(env = process.env) {
  const timeZone = env.HEALTH_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`HEALTH_TZ "${timeZone}" is not a valid IANA time zone (e.g. America/New_York).`);
  }
  return {
    port: Number(env.PORT) || 8787,
    host: env.HOST || '0.0.0.0',
    secret: env.CONNECTOR_SECRET || '',
    dataFile: env.HEALTH_DATA_FILE || path.join(here, '..', 'data', 'health.json'),
    timeZone,
  };
}
