import { describe, expect, it } from 'vitest';
import { codexCwdForPath } from '../src/workspaces/agents/codexCwdPreference';

describe('codex cwd preference paths', () => {
  it('uses a directory as the cwd', () => {
    expect(codexCwdForPath('/srv/project', true)).toBe('/srv/project');
    expect(codexCwdForPath('~/project/', true)).toBe('~/project');
  });

  it('uses a file parent as the cwd', () => {
    expect(codexCwdForPath('/srv/project/readme.md', false)).toBe('/srv/project');
    expect(codexCwdForPath('~/readme.md', false)).toBe('~');
    expect(codexCwdForPath('/readme.md', false)).toBe('/');
  });
});
