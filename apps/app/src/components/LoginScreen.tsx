import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowRight, ShieldCheck, SquareTerminal, ArrowLeft } from 'lucide-react';
import type { LoginResult } from '@cozypad/contracts';
import { message, post } from '../api';
import { Busy } from './Controls';

export function LoginScreen({ trustDays, onLogin }: { trustDays: number; onLogin: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<LoginResult | null>(null);
  const [remember, setRemember] = useState(true);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (challenge?.setup) void QRCode.toDataURL(challenge.setup.otpauthUrl, { margin: 2, width: 176 }).then(value => { if (active) setQr(value); });
    return () => { active = false; };
  }, [challenge]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = challenge
        ? await post<LoginResult>('/auth/verify', { challengeId: challenge.challengeId, code, remember })
        : await post<LoginResult>('/auth/login', { username, password });
      setPassword('');
      if (result.user) await onLogin(); else setChallenge(result);
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  return <main className="login-page">
    <div className="login-brand"><SquareTerminal size={24} /><strong>CozyPad<span>TT</span></strong></div>
    <section className="login-form">
      <div className="login-mark"><ShieldCheck size={26} /></div>
      <h1>{challenge ? (challenge.setup ? '設定雙重驗證' : '確認是你本人') : '登入工作空間'}</h1>
      <p className="muted">{challenge ? username : 'CozyPad TT'}</p>
      <form onSubmit={submit}>
        {!challenge ? <>
          <label>帳號<input autoFocus autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required disabled={busy} /></label>
          <label>密碼<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy} /></label>
        </> : <>
          {challenge.setup && <div className="totp-setup">{qr && <img src={qr} alt="驗證器設定 QR Code" />}<code>{challenge.setup.secret}</code></div>}
          <label>驗證碼<input autoFocus type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} required disabled={busy} /></label>
          <label className="checkbox"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} disabled={busy} />信任此瀏覽器 {trustDays} 天</label>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary login-submit" disabled={busy}>{busy ? <Busy label="驗證中" /> : <>{challenge ? '驗證並登入' : '登入'}<ArrowRight size={17} /></>}</button>
        {challenge && <button type="button" className="text-button" disabled={busy} onClick={() => { setChallenge(null); setCode(''); setError(''); }}><ArrowLeft size={15} />返回登入</button>}
      </form>
    </section>
    <footer>COZYPAD TT <span>V4.0 · SSH WORKSPACE</span></footer>
  </main>;
}
