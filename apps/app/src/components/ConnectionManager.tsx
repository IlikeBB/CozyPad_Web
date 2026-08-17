import { useState } from 'react';
import type {
  AuthenticationMethod,
  ConnectionProfile,
  HostKeyPromptEvent,
} from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';
import { validateConnectionFields } from './connectionManagerValidation';
import { LegacyApiError, type LegacySshProvisioningStage } from '../workspaces/agents/legacySshApi';

interface ConnectionManagerProps {
  profiles: ConnectionProfile[];
  managedProfileIds?: ReadonlySet<string>;
  managedProfileStatuses?: ReadonlyMap<string, string>;
  onClose(): void;
  onChanged(): void | Promise<void>;
  onImportSshConfig?(): Promise<number>;
  onSaveManagedProfile?(profile: ManagedConnectionProfileDraft): Promise<{ id: string }>;
  onProvisionManagedProfile?(
    profileId: string,
    password: string,
    expectedHostFingerprint?: string,
  ): Promise<void>;
  onDeleteManagedProfile?(profileId: string): Promise<void>;
  mutationsDisabled?: boolean;
}

export type ManagedConnectionProfileDraft = {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthenticationMethod;
  password: string;
};

interface FormState {
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
}

const EMPTY_FORM: FormState = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  rememberCredential: true,
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

function provisioningErrorMessage(error: unknown): string {
  if (!(error instanceof LegacyApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const messages: Record<string, string> = {
    HOST_UNREACHABLE: 'Cannot reach the SSH host. Check the host, port, VPN, and firewall, then retry.',
    HOST_KEY_UNKNOWN: 'Confirm the SSH host fingerprint before continuing.',
    HOST_KEY_CHANGED: 'The SSH host key changed. Verify it with the server administrator before retrying.',
    SSH_AUTH_FAILED: 'SSH password authentication failed. Check the username and password, then retry.',
    KEY_GENERATION_FAILED: 'Could not generate the local SSH key. Check local permissions and retry.',
    KEY_INSTALL_FAILED: 'The key could not be installed remotely. No password was saved.',
    KEY_VERIFICATION_FAILED: 'The key was installed but verification failed; CozyPad attempted rollback.',
    PROFILE_COMMIT_FAILED: 'The SSH key worked, but the profile could not be saved; CozyPad attempted rollback.',
    CLEANUP_FAILED: 'Provisioning failed and cleanup needs manual attention.',
    DUPLICATE_PROFILE: 'This profile or provisioning operation already exists.',
    INVALID_INPUT: 'Check the SSH profile fields and retry.',
  };
  const base = error.code ? messages[error.code] : '';
  const cleanup = error.cleanup === 'required'
    ? ' Remote cleanup is still required.'
    : error.cleanup === 'complete'
      ? ' Rollback completed.'
      : '';
  return `${base || error.message}${cleanup}`;
}

export function ConnectionManager({
  profiles,
  managedProfileIds = new Set<string>(),
  managedProfileStatuses = new Map<string, string>(),
  onClose,
  onChanged,
  onImportSshConfig,
  onSaveManagedProfile,
  onProvisionManagedProfile,
  onDeleteManagedProfile,
  mutationsDisabled = false,
}: ConnectionManagerProps) {
  const bridge = getBridge();
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [provisioningStage, setProvisioningStage] = useState<LegacySshProvisioningStage | null>(null);
  const [pendingProvision, setPendingProvision] = useState<{
    profileId: string;
    password: string;
    confirmation: { fingerprintSha256: string; host: string; port: number; keyType?: string };
  } | null>(null);

  const set = (patch: Partial<FormState>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));

  const closeForm = () => {
    setForm(null);
    setError(null);
    setProvisioningStage(null);
    setPendingProvision(null);
  };

  const provision = async (profileId: string, password: string, expectedHostFingerprint?: string) => {
    if (!onProvisionManagedProfile) return;
    setBusy(true);
    if (expectedHostFingerprint) setPendingProvision(null);
    setProvisioningStage(expectedHostFingerprint ? 'generating-key' : 'verifying-host');
    try {
      await onProvisionManagedProfile(profileId, password, expectedHostFingerprint);
      setProvisioningStage('ready');
      await onChanged();
      setPendingProvision(null);
      setForm(null);
    } catch (err: unknown) {
      if (err instanceof LegacyApiError && err.code === 'HOST_KEY_UNKNOWN' && err.confirmation) {
        await onChanged();
        setProvisioningStage('verifying-host');
        setPendingProvision({
          profileId,
          password,
          confirmation: err.confirmation as {
            fingerprintSha256: string;
            host: string;
            port: number;
            keyType?: string;
          },
        });
        return;
      }
      if (err instanceof LegacyApiError && err.stage) setProvisioningStage(err.stage);
      await onChanged();
      setError(provisioningErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (connectAfterSave = false) => {
    if (!form) return;
    const validationError = validateConnectionFields(form);
    if (validationError) {
      setError(validationError);
      return;
    }
    const port = Number(form.port);
    const existing = form.id
      ? profiles.find((profile) => profile.id === form.id)
      : undefined;
    const targetUnchanged =
      existing !== undefined &&
      existing.host === form.host &&
      existing.port === port &&
      existing.username === form.username;
    const keepsExistingCredential =
      existing !== undefined &&
      targetUnchanged &&
      profileAuthMethod(existing) === form.authMethod &&
      hasCredential(existing);
    const suppliedCredential =
      form.authMethod === 'privateKey'
        ? form.privateKey.trim() !== ''
        : form.password !== '';
    const editsManagedProfile = Boolean(form.id && managedProfileIds.has(form.id));
    if (connectAfterSave && !suppliedCredential && !keepsExistingCredential && !editsManagedProfile) {
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
      const managed = form.id === undefined || managedProfileIds.has(form.id);
      if (managed && onSaveManagedProfile) {
        const saved = await onSaveManagedProfile({
          ...(form.id === undefined ? {} : { id: form.id }),
          name: form.name.trim(),
          host: form.host.trim(),
          port,
          username: form.username.trim(),
          authMethod: form.authMethod,
          password: form.password,
        });
        if (connectAfterSave) {
          set({ id: saved.id });
          await provision(saved.id, form.password);
          return;
        }
      } else {
        await bridge.saveProfile({
          ...(form.id === undefined ? {} : { id: form.id }),
          name: form.name.trim(),
          host: form.host.trim(),
          port,
          username: form.username.trim(),
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
      }
      await onChanged();
      setForm(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profileId: string) => {
    setBusy(true);
    setError(null);
    try {
      if (managedProfileIds.has(profileId) && onDeleteManagedProfile) {
        await onDeleteManagedProfile(profileId);
      } else {
        await bridge.deleteProfile({ profileId });
      }
      await onChanged();
      setConfirmDelete(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const importSshConfig = async () => {
    if (!onImportSshConfig) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const count = await onImportSshConfig();
      setNotice(`Imported ${count} SSH host${count === 1 ? '' : 's'} from ~/.ssh/config.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal connection-manager-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>連線管理</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="connection-manager-body">
        {form === null ? (
          <>
            {mutationsDisabled ? (
              <p className="hint" role="status">
                Disconnect SSH before importing, adding, editing, or deleting connection settings.
              </p>
            ) : null}
            <div className="profile-list">
              {profiles.map((profile) => (
                <div
                  key={profile.id}
                  className="profile-row"
                  data-provisioning-status={managedProfileStatuses.get(profile.id)}
                  title={managedProfileStatuses.get(profile.id)
                    ? `SSH profile status: ${managedProfileStatuses.get(profile.id)}`
                    : undefined}
                >
                  <div className="profile-row-main">
                    <span className="profile-row-name">
                      {profile.name}
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
                    </span>
                    {managedProfileStatuses.get(profile.id) ? (
                      <span className="hint">Status · {managedProfileStatuses.get(profile.id)}</span>
                    ) : null}
                    {managedProfileIds.has(profile.id) ? (
                      <span className="hint">SSH config · managed by the backend</span>
                    ) : null}
                  </div>
                  <button
                    disabled={mutationsDisabled}
                    onClick={() =>
                      setForm({
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
                      })
                    }
                  >
                    編輯
                  </button>
                  {confirmDelete === profile.id ? (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => void remove(profile.id)}
                    >
                      確定刪除
                    </button>
                  ) : (
                    <button disabled={mutationsDisabled} onClick={() => setConfirmDelete(profile.id)}>刪除</button>
                  )}
                </div>
              ))}
              {profiles.length === 0 ? (
                <p className="hint">還沒有連線，先新增一個。</p>
              ) : null}
            </div>
            {notice ? <p className="hint" role="status">{notice}</p> : null}
            {error ? <p className="error-banner" role="alert">{error}</p> : null}
            {onImportSshConfig ? (
              <button disabled={busy || mutationsDisabled} onClick={() => void importSshConfig()}>
                {busy ? 'Importing…' : 'Import ~/.ssh'}
              </button>
            ) : null}
            <button className="primary" disabled={mutationsDisabled} onClick={() => setForm({ ...EMPTY_FORM })}>
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
            {error ? <p className="form-error">{error}</p> : null}
            {provisioningStage ? (
              <p className="hint" role="status">SSH provisioning · {provisioningStage}</p>
            ) : null}
            {pendingProvision ? (
              <div className="hostkey-fp" role="alertdialog" aria-label="Confirm SSH host key">
                <strong>Confirm this host before the password is sent</strong>
                <span className="hint">
                  {pendingProvision.confirmation.host}:{pendingProvision.confirmation.port} · SHA256
                </span>
                <code className="mono">{pendingProvision.confirmation.fingerprintSha256}</code>
                <div className="form-actions">
                  <button onClick={() => {
                    setPendingProvision(null);
                    setProvisioningStage(null);
                  }}>Cancel</button>
                  <button className="primary" onClick={() => void provision(
                    pendingProvision.profileId,
                    form?.password || pendingProvision.password,
                    pendingProvision.confirmation.fingerprintSha256,
                  )}>Trust &amp; continue</button>
                </div>
              </div>
            ) : null}
            <div className="form-actions">
              <button onClick={closeForm}>取消</button>
              <button className="save-without-connect" disabled={busy} onClick={() => void save(false)}>
                {form.id ? 'Save changes' : 'Save without connecting'}
              </button>
              {form.authMethod === 'password' && onProvisionManagedProfile ? (
                <button className="primary" disabled={busy} onClick={() => void save(true)}>
                  Add &amp; Connect
                </button>
              ) : null}
            </div>
          </div>
        )}
        </div>
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
