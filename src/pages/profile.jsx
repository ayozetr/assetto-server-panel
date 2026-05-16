// Page: My Account (password change + generator). Split out of settings.jsx
// for size.
const { useState: useStateP, useEffect: useEffectP, useRef: useRefP } = React;
const I4P = window.AppIcons;

// ── Profile / Change password ─────────────────────────────────────────────────
function PageProfile({ user, setUser }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell.useToast();

  const [currentPw,  setCurrentPw]  = useStateP('');
  const [newPw,      setNewPw]      = useStateP('');
  const [confirmPw,  setConfirmPw]  = useStateP('');
  const [showCurrent,setShowCurrent]= useStateP(false);
  const [showNew,    setShowNew]    = useStateP(false);
  const [saving,     setSaving]     = useStateP(false);
  const [formError,  setFormError]  = useStateP('');

  const [genLength,  setGenLength]  = useStateP(16);
  const [genSpecial, setGenSpecial] = useStateP(true);
  const [generated,  setGenerated]  = useStateP('');

  // Crypto-secure: Math.random() exposes V8's xorshift state; one observed password
  // can predict the next. crypto.getRandomValues() is the WebCrypto CSPRNG.
  // Modulo bias is avoided with rejection sampling (drop values outside the largest
  // multiple-of-N below 2^32).
  const secureRandomInt = (max) => {
    if (max <= 0) return 0;
    const limit = Math.floor(0x100000000 / max) * max; // largest multiple of max that fits in u32
    const buf = new Uint32Array(1);
    let v;
    do { window.crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
    return v % max;
  };
  const pick = (s) => s[secureRandomInt(s.length)];
  const buildPassword = (length, special) => {
    const lower   = 'abcdefghijklmnopqrstuvwxyz';
    const upper   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits  = '0123456789';
    const specials = '!@#$%^&*()_+-=[]{}|;:,.?';
    const pool = lower + upper + digits + (special ? specials : '');
    let pwd = pick(lower) + pick(upper) + pick(digits);
    if (special) pwd += pick(specials);
    while (pwd.length < length) pwd += pick(pool);
    const arr = pwd.split('');
    for (let i = arr.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.join('');
  };

  const generatePassword = () => setGenerated(buildPassword(genLength, genSpecial));

  useEffectP(() => { setGenerated(buildPassword(genLength, genSpecial)); }, [genLength, genSpecial]);

  const copyPassword = () => {
    if (!generated) return;
    navigator.clipboard.writeText(generated).then(
      () => toast.push(t('profile.copied'), 'success'),
      () => toast.push(t('profile.copy_fail'), 'warn')
    );
  };

  const useGeneratedPassword = () => {
    if (!generated) return;
    setNewPw(generated);
    setConfirmPw(generated);
    toast.push(t('profile.inserted'), 'info');
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setFormError('');
    if (!currentPw || !newPw || !confirmPw) { setFormError(t('profile.err_req')); return; }
    if (newPw !== confirmPw) { setFormError(t('profile.err_match')); return; }
    if (!window.passesPwPolicy(newPw)) { setFormError(t('profile.err_len')); return; }
    if (newPw === currentPw) { setFormError(t('profile.err_diff')); return; }
    setSaving(true);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const d = await r.json();
      if (d.ok) {
        toast.push(t('profile.pw_updated'), 'success');
        setCurrentPw(''); setNewPw(''); setConfirmPw('');
        if (setUser) setUser(u => ({ ...u, mustChangePassword: false }));
      } else {
        setFormError(d.error || t('common.error'));
      }
    } catch {
      setFormError(t('common.net_error'));
    } finally {
      setSaving(false);
    }
  };

  const eyeBtn = (show, toggle) => (
    <button type="button" onClick={toggle}
      style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}
    >
      {show ? <I4P.IconEyeOff size={14}/> : <I4P.IconEye size={14}/>}
    </button>
  );

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('profile.title')}</h1>
        <p className="page-sub">{t('profile.sub')}</p>
      </div>

      {user?.mustChangePassword && (
        <div style={{
          background: 'color-mix(in srgb, var(--red) 12%, var(--bg-2))',
          border: '1px solid var(--red)',
          borderRadius: 'var(--radius)',
          padding: '12px 16px',
          marginBottom: 20,
          fontSize: 13,
          color: 'var(--text)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <I4P.IconAlertTriangle size={16} style={{color:'var(--red)',flexShrink:0}}/>
          {t('profile.must_change')}
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <I4P.IconKey size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('profile.change_pw')}</div>
          </div>
          <form className="card-body col" style={{gap:14}} onSubmit={handleSubmit}>
            <div className="field">
              <label className="field-label">{t('profile.cur_pw')}</label>
              <div style={{position:'relative'}}>
                <input className="input" type={showCurrent ? 'text' : 'password'}
                  value={currentPw} onChange={e=>setCurrentPw(e.target.value)}
                  placeholder="••••••••" style={{paddingRight:36}}/>
                {eyeBtn(showCurrent, () => setShowCurrent(v=>!v))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t('profile.new_pw')}</label>
              <div style={{position:'relative'}}>
                <input className="input" type={showNew ? 'text' : 'password'}
                  value={newPw} onChange={e=>setNewPw(e.target.value)}
                  placeholder="••••••••" style={{paddingRight:36}}/>
                {eyeBtn(showNew, () => setShowNew(v=>!v))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t('profile.confirm_pw')}</label>
              <input className="input" type="password"
                value={confirmPw} onChange={e=>setConfirmPw(e.target.value)}
                placeholder="••••••••"/>
            </div>
            {formError && <div style={{fontSize:12,color:'var(--red)'}}>{formError}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving} style={{alignSelf:'flex-start'}}>
              <I4P.IconCheck size={13}/> {saving ? t('common.saving') : t('profile.change_pw')}
            </button>
          </form>
        </div>

        <div className="card">
          <div className="card-header">
            <I4P.IconRefresh size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('profile.gen_title')}</div>
          </div>
          <div className="card-body col" style={{gap:14}}>
            <div className="field">
              <label className="field-label">{t('profile.len')} <strong>{genLength}</strong> {t('profile.chars')}</label>
              <input type="range" min="8" max="24" value={genLength}
                onChange={e=>setGenLength(Number(e.target.value))}
                style={{width:'100%',accentColor:'var(--red)',cursor:'pointer'}}/>
              <div className="row-between" style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>
                <span>8</span><span>16</span><span>24</span>
              </div>
            </div>

            <div className="row-between">
              <div>
                <div style={{fontSize:13,fontWeight:500}}>{t('profile.specials')}</div>
                <div className="muted" style={{fontSize:11.5}}>{'!@#$%^&*()_+-=[]{}|'}</div>
              </div>
              <window.AppShell.Switch on={genSpecial} ariaLabel="Include special characters" onChange={v=>setGenSpecial(v)}/>
            </div>

            <div className="field">
              <label className="field-label">{t('profile.generated')}</label>
              <div style={{display:'flex',gap:6,alignItems:'center'}}>
                <div style={{flex:1,position:'relative'}}>
                  <div className="input mono" style={{padding:'7px 36px 7px 10px',background:'var(--bg-3)',wordBreak:'break-all',fontSize:12,userSelect:'all',minHeight:34,display:'flex',alignItems:'center'}}>
                    {generated || '…'}
                  </div>
                  <button type="button" onClick={generatePassword} title="Regenerar"
                    style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}
                  >
                    <I4P.IconRefresh size={14}/>
                  </button>
                </div>
                <button type="button" className="icon-btn" onClick={copyPassword} title={t('profile.copy')}>
                  <I4P.IconCopy size={14}/>
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={useGeneratedPassword}>
                  {t('profile.use')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <TwoFactorCard user={user} setUser={setUser} t={t}/>
    </>
  );
}

// ── Two-factor authentication card ───────────────────────────────────────────
// Three states managed by status + a local UI step:
//   - disabled  + step "idle"      → show "Enable 2FA" button
//   - disabled  + step "setup"     → show secret + otpauth + 6-digit code input
//   - enabled                      → show "Disable" form (password + code)
//
// The QR is rendered locally via the vendored qrcode-generator library (MIT,
// shipped under /dist/vendor/) so the otpauth secret never leaves the device.
// Manual entry of the secret remains supported as a fallback for setups where
// scanning is not available (terminal, screen reader, copy/paste workflow).
function TwoFactorCard({ user, setUser, t }) {
  const toast = window.AppShell.useToast();
  const [enabled, setEnabled] = useStateP(false);
  const [pending, setPending] = useStateP(false);
  const [loaded,  setLoaded]  = useStateP(false);
  const [step,    setStep]    = useStateP('idle'); // 'idle' | 'setup' | 'disable'
  const [secret,  setSecret]  = useStateP('');
  const [otpauth, setOtpauth] = useStateP('');
  const [code,    setCode]    = useStateP('');
  const [pw,      setPw]      = useStateP('');
  const [busy,    setBusy]    = useStateP(false);
  const qrRef = useRefP(null);

  // Render the otpauth:// URI as a QR onto <canvas> as soon as we have it.
  // typeNumber=0 lets qrcode-generator auto-pick the smallest version that
  // fits the payload; 'M' is medium error correction — enough recovery for a
  // dirty screen without blowing up the module count for a ~120-char URI.
  useEffectP(() => {
    if (step !== 'setup' || !otpauth || !qrRef.current || typeof window.qrcode !== 'function') return;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(otpauth);
      qr.make();
      const count = qr.getModuleCount();
      const cell  = 5;
      const pad   = 16;
      const size  = count * cell + pad * 2;
      const canvas = qrRef.current;
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect(pad + c * cell, pad + r * cell, cell, cell);
        }
      }
    } catch { /* fallback to manual entry below */ }
  }, [step, otpauth]);

  const refresh = () => fetch('/api/auth/2fa/status').then(r => r.json()).then(d => {
    setEnabled(!!d.enabled);
    setPending(!!d.pending);
    setLoaded(true);
  }).catch(() => setLoaded(true));
  useEffectP(() => { refresh(); }, []);

  const startSetup = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/auth/2fa/setup', { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        setSecret(d.secret);
        setOtpauth(d.otpauth);
        setStep('setup');
      } else {
        toast.push(d.error || t('common.error'), 'error');
      }
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setBusy(false); }
  };

  const confirmSetup = async () => {
    if (!/^\d{6}$/.test(code)) { toast.push(t('profile.tfa.code_format') || '6-digit code required', 'error'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/2fa/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (d.ok) {
        toast.push(t('profile.tfa.enabled') || 'Two-factor enabled', 'success');
        setStep('idle'); setCode(''); setSecret(''); setOtpauth('');
        setUser(u => u ? ({ ...u, twoFactorEnabled: true }) : u);
        refresh();
      } else {
        toast.push(d.error || t('common.error'), 'error');
      }
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setBusy(false); }
  };

  const cancelSetup = () => { setStep('idle'); setCode(''); setSecret(''); setOtpauth(''); };

  const disableTwoFactor = async () => {
    if (!pw || !/^\d{6}$/.test(code)) {
      toast.push(t('profile.tfa.disable_req') || 'Current password and 6-digit code required', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: pw, code }),
      });
      const d = await r.json();
      if (d.ok) {
        toast.push(t('profile.tfa.disabled') || 'Two-factor disabled', 'success');
        setStep('idle'); setCode(''); setPw('');
        setUser(u => u ? ({ ...u, twoFactorEnabled: false }) : u);
        refresh();
      } else {
        toast.push(d.error || t('common.error'), 'error');
      }
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setBusy(false); }
  };

  const copyText = (s) => {
    try { navigator.clipboard.writeText(s); toast.push(t('profile.copied') || 'Copied', 'success'); }
    catch { toast.push(t('common.error'), 'error'); }
  };

  if (!loaded) return null;

  return (
    <div className="card" style={{marginTop: 16}}>
      <div className="card-header">
        <I4P.IconShield size={14} style={{color: enabled ? '#16a34a' : 'var(--text-muted)'}}/>
        <div className="card-title">{t('profile.tfa.title') || 'Two-factor authentication'}</div>
      </div>
      <div className="card-body col" style={{gap: 12}}>
        {step === 'idle' && !enabled && (
          <>
            <p className="muted" style={{fontSize: 13, margin: 0}}>
              {t('profile.tfa.intro') || 'Protect your account with a 6-digit time-based code from an authenticator app (Aegis, Authy, Bitwarden, 2FAS, Google Authenticator). You will be asked for it on every login.'}
            </p>
            <div className="row" style={{gap: 8}}>
              <button className="btn btn-primary" disabled={busy} onClick={startSetup}>
                <I4P.IconShield size={13}/> {t('profile.tfa.enable') || 'Enable 2FA'}
              </button>
            </div>
          </>
        )}

        {step === 'idle' && enabled && (
          <>
            <div className="row" style={{gap: 8, alignItems:'center'}}>
              <span className="badge" style={{background:'color-mix(in srgb, #16a34a 14%, transparent)', color:'#16a34a'}}>{t('profile.tfa.active') || 'Active'}</span>
              <span className="muted" style={{fontSize: 12.5}}>{t('profile.tfa.active_hint') || 'A code from your authenticator app is required on every login.'}</span>
            </div>
            <button className="btn btn-sm" disabled={busy} onClick={() => setStep('disable')} style={{alignSelf:'flex-start'}}>
              {t('profile.tfa.disable') || 'Disable 2FA'}
            </button>
          </>
        )}

        {step === 'setup' && (
          <>
            <p className="muted" style={{fontSize: 13, margin: 0}}>
              {t('profile.tfa.setup_intro') || 'Scan the QR with your authenticator app — or enter the key below manually if you cannot scan.'}
            </p>
            <div style={{display:'flex', justifyContent:'center', padding:'4px 0'}}>
              <canvas
                ref={qrRef}
                aria-label={t('profile.tfa.qr_alt') || 'QR code for two-factor setup'}
                role="img"
                style={{maxWidth:'100%', height:'auto', borderRadius:6, boxShadow:'0 0 0 1px var(--border-1)'}}
              />
            </div>
            <p className="muted" style={{fontSize: 13, margin: 0}}>
              {t('profile.tfa.setup_step1') || 'Or add the account manually — choose "Add account" → "Enter setup key" in your app, and paste these values:'}
            </p>
            <div className="field">
              <label className="field-label">{t('profile.tfa.account_label') || 'Account / Label'}</label>
              <div className="row" style={{gap: 6, alignItems:'center'}}>
                <div className="input mono" style={{flex:1, padding:'7px 10px', background:'var(--bg-3)', fontSize:12, userSelect:'all', minHeight:34, display:'flex', alignItems:'center'}}>
                  Assetto Server Panel:{user.name}
                </div>
                <button type="button" className="icon-btn" onClick={() => copyText(`Assetto Server Panel:${user.name}`)} title={t('profile.copy') || 'Copy'}>
                  <I4P.IconCopy size={14}/>
                </button>
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t('profile.tfa.secret_label') || 'Setup key (base32 secret)'}</label>
              <div className="row" style={{gap: 6, alignItems:'center'}}>
                <div className="input mono" style={{flex:1, padding:'7px 10px', background:'var(--bg-3)', fontSize:12, wordBreak:'break-all', userSelect:'all', minHeight:34, display:'flex', alignItems:'center'}}>
                  {secret.replace(/(.{4})/g, '$1 ').trim()}
                </div>
                <button type="button" className="icon-btn" onClick={() => copyText(secret)} title={t('profile.copy') || 'Copy'}>
                  <I4P.IconCopy size={14}/>
                </button>
              </div>
              <span className="field-hint">{t('profile.tfa.secret_hint') || 'Algorithm SHA-1 · 6 digits · 30 s period (the defaults every app expects).'}</span>
            </div>
            <details style={{fontSize: 12}}>
              <summary className="muted" style={{cursor:'pointer'}}>{t('profile.tfa.uri_summary') || 'Or copy the otpauth:// URI (some apps support paste)'}</summary>
              <div className="row" style={{gap: 6, alignItems:'center', marginTop: 6}}>
                <div className="input mono" style={{flex:1, padding:'7px 10px', background:'var(--bg-3)', fontSize:11, wordBreak:'break-all', userSelect:'all'}}>
                  {otpauth}
                </div>
                <button type="button" className="icon-btn" onClick={() => copyText(otpauth)} title={t('profile.copy') || 'Copy'}>
                  <I4P.IconCopy size={14}/>
                </button>
              </div>
            </details>
            <p className="muted" style={{fontSize: 13, margin: 0, marginTop: 4}}>
              {t('profile.tfa.setup_step2') || 'Step 2: once added, your app shows a 6-digit code that rotates every 30 seconds. Enter the current one below to confirm.'}
            </p>
            <div className="field">
              <label className="field-label">{t('profile.tfa.code_label') || 'Current code'}</label>
              <input className="input mono" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                style={{maxWidth:140, fontSize:16, letterSpacing:'0.18em'}}
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000" autoComplete="one-time-code"/>
            </div>
            <div className="row" style={{gap: 6}}>
              <button className="btn" disabled={busy} onClick={cancelSetup}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={busy || code.length !== 6} onClick={confirmSetup}>
                <I4P.IconCheck size={13}/> {t('profile.tfa.confirm') || 'Confirm and enable'}
              </button>
            </div>
          </>
        )}

        {step === 'disable' && (
          <>
            <p className="muted" style={{fontSize: 13, margin: 0}}>
              {t('profile.tfa.disable_intro') || 'Disabling 2FA removes the second factor from your account. Confirm with your current password and a fresh 6-digit code.'}
            </p>
            <div className="field">
              <label className="field-label">{t('profile.current_pw') || 'Current password'}</label>
              <input className="input" type="password" autoComplete="current-password"
                value={pw} onChange={e => setPw(e.target.value)}/>
            </div>
            <div className="field">
              <label className="field-label">{t('profile.tfa.code_label') || 'Current code'}</label>
              <input className="input mono" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                style={{maxWidth:140, fontSize:16, letterSpacing:'0.18em'}}
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000" autoComplete="one-time-code"/>
            </div>
            <div className="row" style={{gap: 6}}>
              <button className="btn" disabled={busy} onClick={() => { setStep('idle'); setCode(''); setPw(''); }}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-danger" disabled={busy || !pw || code.length !== 6} onClick={disableTwoFactor}>
                {t('profile.tfa.disable_confirm') || 'Disable 2FA'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

window.AppPagesSettings = window.AppPagesSettings || {};
window.AppPagesSettings.PageProfile = PageProfile;
