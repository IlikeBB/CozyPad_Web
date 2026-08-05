import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import QRCode from 'qrcode';
import {
  loginLegacy,
  verifyLegacyTwoFactor,
} from '../workspaces/agents/legacySshApi';
import type {
  LegacyAuthUser,
  LegacyLoginResponse,
  LegacyTwoFactorSetup,
} from '../workspaces/agents/legacySshApi';

type LoginStep =
  | { kind: 'credentials' }
  | {
      kind: 'twoFactor';
      challengeId: string;
      username: string;
      setup?: LegacyTwoFactorSetup;
    };

function getTwoFactorStep(
  response: LegacyLoginResponse,
  fallbackUsername: string,
): LoginStep | null {
  if ((response.requiresTwoFactor || response.requiresTwoFactorSetup) && response.challengeId) {
    return {
      kind: 'twoFactor',
      challengeId: response.challengeId,
      username: response.user?.username || fallbackUsername,
      setup: response.requiresTwoFactorSetup ? response.setup : undefined,
    };
  }
  return null;
}

export function LoginScreen({
  onAuthenticated,
}: {
  onAuthenticated: (user: LegacyAuthUser) => void;
}) {
  const [step, setStep] = useState<LoginStep>({ kind: 'credentials' });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const otpauthUrl = step.kind === 'twoFactor' ? step.setup?.otpauthUrl || '' : '';
    if (!otpauthUrl) {
      setQrDataUrl('');
      return () => {
        active = false;
      };
    }

    QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 5,
      color: {
        dark: '#050506',
        light: '#f5f5f5',
      },
    })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });

    return () => {
      active = false;
    };
  }, [step]);

  const submitCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const cleanUsername = username.trim();
      const response = await loginLegacy(cleanUsername, password);
      const nextStep = getTwoFactorStep(response, cleanUsername);
      if (nextStep) {
        setStep(nextStep);
        setPassword('');
        return;
      }
      if (response.user) {
        onAuthenticated(response.user);
        return;
      }
      throw new Error(response.error || '登入回應格式不正確');
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登入失敗');
    } finally {
      setBusy(false);
    }
  };

  const submitTwoFactor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step.kind !== 'twoFactor') return;
    setBusy(true);
    setError('');
    try {
      const response = await verifyLegacyTwoFactor(step.challengeId, code.trim());
      if (!response.user) {
        throw new Error(response.error || '驗證回應格式不正確');
      }
      onAuthenticated(response.user);
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : '驗證失敗');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <header className="login-card-head">
          <div className="login-mark" aria-hidden="true">
            &gt;_
          </div>
          <div>
            <h1 id="login-title">CozyPad</h1>
            <span>{step.kind === 'twoFactor' ? '雙重驗證' : '登入'}</span>
          </div>
        </header>

        {step.kind === 'credentials' ? (
          <form className="login-form" onSubmit={(event) => void submitCredentials(event)}>
            <label>
              <span>帳號</span>
              <input
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              <span>密碼</span>
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error ? <p className="login-error">{error}</p> : null}
            <button type="submit" disabled={busy || !username.trim() || !password}>
              {busy ? '登入中...' : '登入'}
            </button>
          </form>
        ) : (
          <form className="login-form" onSubmit={(event) => void submitTwoFactor(event)}>
            <label>
              <span>帳號</span>
              <input value={step.username} readOnly />
            </label>
            {step.setup ? (
              <div className="login-setup">
                <strong>首次設定 TOTP</strong>
                {qrDataUrl ? (
                  <img className="login-qr" src={qrDataUrl} alt="TOTP QR code" />
                ) : null}
                <span>Secret: {step.setup.secret}</span>
                <code>{step.setup.otpauthUrl}</code>
              </div>
            ) : null}
            <label>
              <span>驗證碼</span>
              <input
                autoFocus
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="6 位數"
                required
              />
            </label>
            {error ? <p className="login-error">{error}</p> : null}
            <button type="submit" disabled={busy || !code.trim()}>
              {busy ? '驗證中...' : '驗證'}
            </button>
            <button
              type="button"
              className="login-secondary"
              onClick={() => {
                setStep({ kind: 'credentials' });
                setCode('');
                setError('');
              }}
              disabled={busy}
            >
              返回
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
