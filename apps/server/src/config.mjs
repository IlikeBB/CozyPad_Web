import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../../', import.meta.url));
try { process.loadEnvFile?.(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
function bounded(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error('Invalid CozyPad configuration');
  return number;
}
export const config = {
  host: process.env.COZYPAD_HOST || '127.0.0.1',
  port: bounded(process.env.COZYPAD_API_PORT, 5674, 1, 65535),
  webPort: bounded(process.env.COZYPAD_WEB_PORT, 5673, 1, 65535),
  dataDir: path.resolve(process.env.COZYPAD_DATA_DIR || path.join(root, 'data')),
  trustDays: bounded(process.env.COZYPAD_TRUST_DAYS, 7, 1, 90),
  sessionHours: bounded(process.env.COZYPAD_SESSION_HOURS, 12, 0.01, 168),
  secureCookie: process.env.COZYPAD_COOKIE_SECURE === 'true',
  publicOrigin: process.env.COZYPAD_PUBLIC_ORIGIN || '',
  distDir: path.resolve(process.env.COZYPAD_DIST_DIR || path.join(root, 'apps/app/dist'))
};
export function allowedOrigin(origin) {
  return [config.publicOrigin, `http://127.0.0.1:${config.webPort}`, `http://localhost:${config.webPort}`,
    `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`].filter(Boolean).includes(origin);
}
