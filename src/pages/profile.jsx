// Page: My Account (password change + generator). Split out of settings.jsx
// for size.
const { useState: useStateP, useEffect: useEffectP } = React;
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
                <div className="muted" style={{fontSize:11.5}}>!@#$%^&amp;*()_+-=[]{}|</div>
              </div>
              <div className={`switch ${genSpecial ? 'on' : ''}`} onClick={()=>setGenSpecial(v=>!v)}></div>
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
    </>
  );
}

window.AppPagesSettings = window.AppPagesSettings || {};
window.AppPagesSettings.PageProfile = PageProfile;
