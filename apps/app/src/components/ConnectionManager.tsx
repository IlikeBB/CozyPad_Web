import { useRef, useState } from 'react';
import type {
  AuthenticationMethod,
  ConnectionProfile,
  HostKeyPromptEvent,
  SshConfigImportResult,
} from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';
import {
  deleteLegacyServer,
  importLegacySshConfig,
  saveLegacyServer,
} from '../workspaces/agents/legacySshApi';
import type { LegacySshConfigImportResult } from '../workspaces/agents/legacySshApi';
import type { LegacySshServer } from '../workspaces/agents/legacySshApi';

type ConnectionManagerSource = 'bridge' | 'legacy';

export type ConnectionManagerProfile = ConnectionProfile & {
  managerSource?: ConnectionManagerSource;
  legacySource?: LegacySshServer['source'];
  sourceName?: string;
  defaultPath?: string;
};

interface ConnectionManagerProps {
  profiles: ConnectionManagerProfile[];
  defaultSource?: ConnectionManagerSource;
  onClose(): void;
  onChanged(): void | Promise<void>;
}

interface FormState {
  source: ConnectionManagerSource;
  legacySource?: LegacySshServer['source'];
  id?: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: AuthenticationMethod;
  password: string;
  privateKey: string;
  passphrase: string;
  rememberCredential: boolean;
  defaultPath: string;
}

const EMPTY_FORM: FormState = {
  source: 'bridge',
  name: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  rememberCredential: true,
  defaultPath: '~',
};

const profileAuthMethod = (profile: ConnectionProfile): AuthenticationMethod =>
  profile.authMethod ?? 'password';

const hasCredential = (
  profile: ConnectionProfile,
  authMethod = profileAuthMethod(profile),
): boolean =>
  authMethod === 'privateKey'
    ? profile.hasPrivateKey === true
    : profile.hasPassword === true;

const profileSource = (profile: ConnectionManagerProfile): ConnectionManagerSource =>
  profile.managerSource ?? 'bridge';

const profileKey = (profile: ConnectionManagerProfile): string =>
  `${profileSource(profile)}:${profile.id}`;

const sourceLabel = (profile: ConnectionManagerProfile | FormState): string => {
  if ('sourceName' in profile && profile.sourceName) return profile.sourceName;
  const source = 'source' in profile ? profile.source : profileSource(profile);
  if (source === 'legacy') {
    if ('legacySource' in profile && profile.legacySource === 'ssh-config') return 'SSH config';
    return 'Web SSH';
  }
  return 'Bridge';
};

function formFromProfile(profile: ConnectionManagerProfile): FormState {
  return {
    source: profileSource(profile),
    legacySource: profile.legacySource,
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authMethod: profileAuthMethod(profile),
    password: '',
    privateKey: '',
    passphrase: '',
    rememberCredential: profile.credentialPersisted === true,
    defaultPath: profile.defaultPath ?? '~',
  };
}

function importSummary(
  result: SshConfigImportResult | LegacySshConfigImportResult,
): string {
  const skipped = result.skipped ?? 0;
  return skipped > 0
    ? `已匯入 ${result.imported} 個 Host，略過 ${skipped} 個 pattern。`
    : `已匯入 ${result.imported} 個 Host。`;
}

export function ConnectionManager({
  profiles,
  defaultSource = 'bridge',
  onClose,
  onChanged,
}: ConnectionManagerProps) {
  const bridge = getBridge();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (patch: Partial<FormState>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));

  const save = async () => {
    if (!form) return;
    const port = Number(form.port);
    if (
      !form.name ||
      !form.host ||
      !form.username ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      setError('name / host / port / username 為必填');
      return;
    }
    const existing = form.id
      ? profiles.find(
          (profile) => profile.id === form.id && profileSource(profile) === form.source,
        )
      : undefined;
    const targetUnchanged =
      existing !== undefined &&
      existing.host === form.host &&
      existing.port === port &&
      existing.username === form.username;

    if (form.source === 'legacy') {
      const passwordRequired =
        existing === undefined ||
        (existing.legacySource !== 'ssh-config' &&
          (!targetUnchanged || existing.hasPrivateKey !== true));
      if (passwordRequired && form.password === '') {
        setError('請輸入 SSH 密碼以安裝或更新 CozyPad SSH key');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await saveLegacyServer({
          ...(form.id === undefined ? {} : { id: form.id }),
          name: form.name,
          host: form.host,
          port,
          user: form.username,
          ...(form.password === '' ? {} : { password: form.password }),
          defaultPath: form.defaultPath.trim() || '~',
        });
        await onChanged();
        setForm(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    const keepsExistingCredential =
      existing !== undefined &&
      targetUnchanged &&
      profileAuthMethod(existing) === form.authMethod &&
      hasCredential(existing);
    const suppliedCredential =
      form.authMethod === 'privateKey'
        ? form.privateKey.trim() !== ''
        : form.password !== '';
    if (!suppliedCredential && !keepsExistingCredential) {
      setError(form.authMethod === 'privateKey' ? '請選取或貼上 SSH 私鑰' : '請輸入密碼');
      return;
    }
    if (
      form.authMethod === 'privateKey' &&
      form.privateKey.trim() !== '' &&
      !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(form.privateKey)
    ) {
      setError('目前支援 OpenSSH 或 PEM 格式的私鑰');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bridge.saveProfile({
        ...(form.id === undefined ? {} : { id: form.id }),
        name: form.name,
        host: form.host,
        port,
        username: form.username,
        authMethod: form.authMethod,
        ...(form.authMethod !== 'password' || form.password === ''
          ? {}
          : { password: form.password }),
        ...(form.authMethod !== 'privateKey' || form.privateKey.trim() === ''
          ? {}
          : {
              privateKey: form.privateKey,
              ...(form.passphrase === '' ? {} : { passphrase: form.passphrase }),
            }),
        rememberCredential: form.rememberCredential,
      });
      await onChanged();
      setForm(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: ConnectionManagerProfile) => {
    setBusy(true);
    setError(null);
    try {
      if (profileSource(profile) === 'legacy') {
        await deleteLegacyServer(profile.id);
      } else {
        await bridge.deleteProfile({ profileId: profile.id });
      }
      await onChanged();
      setConfirmDelete(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const importSshConfigText = async (rawConfig: string, sourcePath: string) => {
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const result =
        defaultSource === 'legacy'
          ? await importLegacySshConfig(rawConfig, sourcePath)
          : await bridge.importSshConfig({ rawConfig, sourcePath });
      await onChanged();
      setNotice(importSummary(result));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const scanLocalSshConfig = async () => {
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await bridge.importSshConfig();
      await onChanged();
      setNotice(importSummary(result));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const canScanLocalSshConfig = defaultSource === 'bridge' && bridge.kind === 'electron';
  const controlsDisabled = busy || importing;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>連線管理</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        {form === null ? (
          <>
            {error ? <p className="form-error">{error}</p> : null}
            {notice ? <p className="form-success">{notice}</p> : null}
            <div className="profile-import-actions">
              {canScanLocalSshConfig ? (
                <button disabled={controlsDisabled} onClick={() => void scanLocalSshConfig()}>
                  掃描本機 ssh_config
                </button>
              ) : null}
              <button
                disabled={controlsDisabled}
                onClick={() => fileInputRef.current?.click()}
              >
                匯入 ssh_config
              </button>
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept=".conf,.config,.sshconfig,text/plain"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (!file) return;
                  const filePath =
                    'path' in file && typeof file.path === 'string' && file.path
                      ? file.path
                      : file.name;
                  void file
                    .text()
                    .then((rawConfig) => importSshConfigText(rawConfig, filePath));
                }}
              />
            </div>
            <div className="profile-list">
              {profiles.map((profile) => {
                const key = profileKey(profile);
                return (
                  <div key={key} className="profile-row">
                    <div className="profile-row-main">
                      <span className="profile-row-name">
                        {profile.name}
                        <span className="profile-source-tag">{sourceLabel(profile)}</span>
                        {hasCredential(profile) ? (
                          <span
                            className="lock"
                            title={
                              profileAuthMethod(profile) === 'privateKey'
                                ? '已有 SSH 私鑰'
                                : '已有密碼'
                            }
                          >
                            {profileAuthMethod(profile) === 'privateKey' ? '🔑' : '🔒'}
                          </span>
                        ) : null}
                      </span>
                      <span className="profile-row-meta mono">
                        {profile.username}@{profile.host}:{profile.port} ·{' '}
                        {profileAuthMethod(profile) === 'privateKey' ? 'Key' : 'Password'}
                        {profile.defaultPath ? ` · ${profile.defaultPath}` : ''}
                      </span>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setConfirmDelete(null);
                        setError(null);
                        setNotice(null);
                        setForm(formFromProfile(profile));
                      }}
                    >
                      編輯
                    </button>
                    {confirmDelete === key ? (
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => void remove(profile)}
                      >
                        確定刪除
                      </button>
                    ) : (
                      <button disabled={busy} onClick={() => setConfirmDelete(key)}>
                        刪除
                      </button>
                    )}
                  </div>
                );
              })}
              {profiles.length === 0 ? (
                <p className="hint">還沒有連線，先新增一個。</p>
              ) : null}
            </div>
            <button
              className="primary"
              onClick={() => {
                setConfirmDelete(null);
                setError(null);
                setNotice(null);
                setForm({ ...EMPTY_FORM, source: defaultSource });
              }}
            >
              ＋ 新增連線
            </button>
          </>
        ) : (
          <div className="profile-form">
            <label>
              名稱
              <input
                value={form.name}
                onChange={(event) => set({ name: event.target.value })}
                placeholder="Lab GPU box"
              />
            </label>
            <div className="form-row">
              <label className="grow">
                Host
                <input
                  value={form.host}
                  onChange={(event) => set({ host: event.target.value })}
                  placeholder="192.168.1.10"
                />
              </label>
              <label className="port">
                Port
                <input
                  value={form.port}
                  onChange={(event) => set({ port: event.target.value })}
                />
              </label>
            </div>
            <label>
              Username
              <input
                value={form.username}
                onChange={(event) => set({ username: event.target.value })}
              />
            </label>
            {form.source === 'legacy' ? (
              <>
                {form.legacySource !== 'ssh-config' ? (
                  <label>
                    Default path
                    <input
                      value={form.defaultPath}
                      onChange={(event) => set({ defaultPath: event.target.value })}
                      placeholder="~"
                    />
                  </label>
                ) : null}
                <label>
                  SSH Password
                  {form.id !== undefined ? '（只在重新安裝 key 時需要）' : ''}
                  <input
                    type="password"
                    value={form.password}
                    onChange={(event) => set({ password: event.target.value })}
                    autoComplete="new-password"
                  />
                </label>
                <p className="hint">
                  類型：{sourceLabel(form)}。修改 host / port / username 時會重新安裝 CozyPad SSH key。
                </p>
              </>
            ) : (
              <>
                <div className="auth-method-field">
                  <span>驗證方式</span>
                  <div className="auth-method-switch" role="group" aria-label="SSH 驗證方式">
                    {(['password', 'privateKey'] as const).map((authMethod) => (
                      <button
                        key={authMethod}
                        type="button"
                        className={form.authMethod === authMethod ? 'active' : ''}
                        onClick={() =>
                          set({
                            authMethod,
                            password: '',
                            privateKey: '',
                            passphrase: '',
                          })
                        }
                      >
                        {authMethod === 'password' ? '密碼' : 'SSH Key'}
                      </button>
                    ))}
                  </div>
                </div>
                {form.authMethod === 'password' ? (
                  <label>
                    Password{form.id !== undefined ? '（留空表示不變更）' : ''}
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => set({ password: event.target.value })}
                      autoComplete="new-password"
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      SSH 私鑰{form.id !== undefined ? '（留空表示不變更）' : ''}
                      <textarea
                        className="private-key-input mono"
                        value={form.privateKey}
                        onChange={(event) => set({ privateKey: event.target.value })}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                      />
                    </label>
                    <label className="credential-file">
                      <span>或從檔案載入 OpenSSH／PEM 私鑰</span>
                      <input
                        type="file"
                        accept=".pem,.key,application/x-pem-file,text/plain"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void file.text().then((privateKey) => set({ privateKey }));
                        }}
                      />
                    </label>
                    <label>
                      Key passphrase（未加密私鑰可留空）
                      <input
                        type="password"
                        value={form.passphrase}
                        onChange={(event) => set({ passphrase: event.target.value })}
                        autoComplete="new-password"
                      />
                    </label>
                  </>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.rememberCredential}
                    onChange={(event) => set({ rememberCredential: event.target.checked })}
                  />
                  以 OS 安全儲存保留驗證資料（關閉時只保留到 app 結束）
                </label>
              </>
            )}
            {error ? <p className="form-error">{error}</p> : null}
            <div className="form-actions">
              <button onClick={() => setForm(null)}>取消</button>
              <button className="primary" disabled={busy} onClick={() => void save()}>
                儲存
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface HostKeyDialogProps {
  prompt: HostKeyPromptEvent;
  onRespond(accept: boolean): void;
}

export function HostKeyDialog({ prompt, onRespond }: HostKeyDialogProps) {
  const changed = prompt.status === 'changed';
  return (
    <div className="modal-overlay">
      <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{changed ? '⚠ Host key 已變更' : '首次連線此主機'}</h2>
        </div>
        {changed ? (
          <p className="hostkey-warning">
            {prompt.host}:{prompt.port} 的 host key 與上次記錄不同。
            可能是主機重灌，也可能是中間人攻擊——請先向管理者確認再繼續。
          </p>
        ) : (
          <p className="hint">
            無法自動驗證 {prompt.host}:{prompt.port} 的身分。請比對下方指紋後決定是否信任。
          </p>
        )}
        <div className="hostkey-fp">
          <span className="hint">{prompt.keyType} · SHA256</span>
          <code className="mono">{prompt.fingerprintSha256}</code>
          {changed && prompt.previousFingerprint ? (
            <>
              <span className="hint">先前記錄</span>
              <code className="mono hostkey-old">{prompt.previousFingerprint}</code>
            </>
          ) : null}
        </div>
        <div className="form-actions">
          <button onClick={() => onRespond(false)}>中止連線</button>
          <button
            className={changed ? 'danger' : 'primary'}
            onClick={() => onRespond(true)}
          >
            {changed ? '仍然信任並更新' : '信任並繼續'}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface CredentialSubmission {
  authMethod: AuthenticationMethod;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  rememberCredential: boolean;
}

interface CredentialPromptProps {
  profile: ConnectionProfile;
  onCancel(): void;
  onSubmit(credential: CredentialSubmission): void;
}

export function CredentialPrompt({ profile, onCancel, onSubmit }: CredentialPromptProps) {
  const authMethod = profileAuthMethod(profile);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);
  const canSubmit =
    authMethod === 'privateKey' ? privateKey.trim() !== '' : password !== '';
  const submit = (): void => {
    if (!canSubmit) return;
    onSubmit({
      authMethod,
      ...(authMethod === 'password'
        ? { password }
        : {
            privateKey,
            ...(passphrase === '' ? {} : { passphrase }),
          }),
      rememberCredential: remember,
    });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{authMethod === 'privateKey' ? '選取 SSH 私鑰' : '輸入密碼'}</h2>
          <button className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <p className="hint">
          {profile.username}@{profile.host}:{profile.port}
        </p>
        {authMethod === 'password' ? (
          <input
            autoFocus
            type="password"
            value={password}
            placeholder="SSH password"
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
        ) : (
          <>
            <textarea
              autoFocus
              className="private-key-input mono"
              value={privateKey}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              onChange={(event) => setPrivateKey(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <label className="credential-file">
              <span>從檔案載入 OpenSSH／PEM 私鑰</span>
              <input
                type="file"
                accept=".pem,.key,application/x-pem-file,text/plain"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void file.text().then(setPrivateKey);
                }}
              />
            </label>
            <input
              type="password"
              value={passphrase}
              placeholder="Key passphrase（可留空）"
              onChange={(event) => setPassphrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
          </>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          以 OS 安全儲存保留驗證資料
        </label>
        <div className="form-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={!canSubmit}
            onClick={submit}
          >
            連線
          </button>
        </div>
      </div>
    </div>
  );
}
