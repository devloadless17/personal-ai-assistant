import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env reader so e2e can use the same admin credentials as the API. */
function loadRootEnv(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(__dirname, '../.env'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = loadRootEnv();

export function env(key: string): string | undefined {
  return process.env[key] ?? fileEnv[key];
}
