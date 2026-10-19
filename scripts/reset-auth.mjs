import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, userId } from '../apps/server/src/storage/json-store.mjs';

export async function resetAuth(store, username) {
  const id = userId(username);
  await store.update('auth-users.json', {}, users => {
    const user = users[id];
    if (!user) throw new Error(`Account not found: ${id}`);
    delete user.twoFactor;
    delete user.lastTotpStep;
  });
  const removed = await store.update('auth-state.json', { sessions: {}, trusted: {} }, state => {
    const counts = { sessions: 0, trusted: 0 };
    for (const name of ['sessions', 'trusted']) {
      for (const [token, record] of Object.entries(state[name])) {
        if (String(record.username).toLowerCase() === id) {
          delete state[name][token];
          counts[name]++;
        }
      }
    }
    return counts;
  });
  return { username: id, ...removed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { config } = await import('../apps/server/src/config.mjs');
  const result = await resetAuth(new JsonStore(config.dataDir), process.argv[2] || 'admin');
  console.log(`Reset authentication for ${result.username}; revoked ${result.sessions} sessions and ${result.trusted} trusted browsers.`);
  console.log('Password and SSH settings preserved. Sign in to enroll the authenticator again.');
}
