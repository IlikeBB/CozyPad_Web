const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.cache', 'dist', 'build', 'logs', 'runs', 'outputs', '.token-guard', '.run-logs']);
const privateNames = new Set(['.env', '.aws', '.ssh', '.codex', '.config', '.cloudflared', '.azure', '.gnupg', 'credentials', 'credentials.json', 'auth.json', 'auth-users.json', 'keyring.json', 'keys', 'known_hosts', 'ssh_config']);
export const excludedDirectoryName = name => excluded.has(name.toLowerCase());
export const privateSearchName = name => privateNames.has(name.toLowerCase()) || /^(?:\.env\.|id_rsa(?:\.|$)|id_ed25519(?:\.|$)|auth-.*\.json$)|\.(?:pem|key|pfx|p12|ed25519)$|(?:^|[-_.])(?:credentials|tokens?|secrets?)\.(?:json|ya?ml|toml|txt)$/i.test(name);
