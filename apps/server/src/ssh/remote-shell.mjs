import { quoteShell, remoteDirectory } from './ssh-service.mjs';

// Retained from CozyPad's CLI bootstrap: noninteractive SSH needs user-local paths.
export function remoteCommand(directory, executable, prelude = []) {
  const script = [
    'set +u',
    'for file in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc"; do [ ! -r "$file" ] || . "$file" >/dev/null 2>&1 || true; done',
    'for directory in "$HOME/.local/bin" "$HOME/bin" "$HOME/.npm-global/bin" "$HOME/.npm/bin" "$HOME/.bun/bin" "$HOME/.cargo/bin"; do [ ! -d "$directory" ] || PATH="$directory:$PATH"; done',
    '[ ! -s "$HOME/.nvm/nvm.sh" ] || . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true',
    'export PATH',
    `cd ${remoteDirectory(directory)} || exit 1`,
    ...prelude,
    `exec ${executable}`
  ].join('\n');
  return `if command -v bash >/dev/null 2>&1; then exec bash -lc ${quoteShell(script)}; else exec sh -lc ${quoteShell(script)}; fi`;
}

export function codexChatCommand(directory) {
  return remoteCommand(directory, 'codex app-server', [
    'printf "__COZYPAD_CWD__%s\\n" "$PWD"',
    'printf "__COZYPAD_CODEX_VERSION__%s\\n" "$(codex --version 2>/dev/null)"'
  ]);
}
