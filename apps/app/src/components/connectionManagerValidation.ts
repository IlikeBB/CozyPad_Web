export type ConnectionFields = {
  name: string;
  host: string;
  port: string;
  username: string;
};

export function validateConnectionFields(fields: ConnectionFields): string | null {
  if (!fields.name.trim() || !fields.host.trim() || !fields.port.trim() || !fields.username.trim()) {
    return '名稱、Host、Port、Username 都是必填。';
  }
  if (!/^\d+$/.test(fields.port.trim())) {
    return 'Port 必須是 1–65535 的整數。';
  }
  const port = Number(fields.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'Port 必須是 1–65535 的整數。';
  }
  return null;
}
