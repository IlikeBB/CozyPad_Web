import { describe, expect, it } from 'vitest';
import { validateConnectionFields } from '../src/components/connectionManagerValidation';

describe('connection manager validation', () => {
  it('rejects an entirely empty form', () => {
    expect(validateConnectionFields({ name: '', host: '', port: '', username: '' }))
      .toContain('必填');
  });

  it('rejects whitespace-only required fields', () => {
    expect(validateConnectionFields({ name: '  ', host: '\t', port: '22', username: '\n' }))
      .toContain('必填');
  });

  it.each(['0', '-1', '22.5', '22abc', '65536'])(
    'rejects invalid port %s',
    (port) => {
      expect(validateConnectionFields({ name: 'lab', host: 'host', port, username: 'user' }))
        .toContain('Port');
    },
  );

  it('accepts trimmed values and a valid port', () => {
    expect(validateConnectionFields({
      name: ' lab ',
      host: ' host.example ',
      port: '7735',
      username: ' user ',
    })).toBeNull();
  });
});
