// Sidebar + Topbar + Toast system + Login screen
const { useState, useRef, createContext, useContext } = React;
const I = window.AppIcons;

// ──────────────────────────────────────────────────────
// Toast context
// ──────────────────────────────────────────────────────
const ToastCtx = createContext({ push: () => {} });
const useToast = () => useContext(ToastCtx);

function ToastProvider({ children }) {
  const [list, setList] = useState([]);
  const push = (msg, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setList(l => [...l, { id, msg, kind }]);
    const ttl = kind === 'error' ? 6000 : kind === 'warn' ? 4500 : kind === 'success' ? 2500 : 3200;
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), ttl);
  };
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {list.map(t => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'success' && <I.IconCheck size={14}/>}
            {t.kind === 'error'   && <I.IconX size={14}/>}
            {t.kind === 'warn'    && <I.IconAlertTriangle size={14}/>}
            {t.kind === 'info'    && <I.IconBell size={14}/>}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ──────────────────────────────────────────────────────
// Sidebar
// ──────────────────────────────────────────────────────
function Sidebar({ page, setPage, user, onLogout, playersCount, osInfo, mobileOpen, onCloseMobile }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const items = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: I.IconDashboard, group: 'general' },
    { id: 'players', label: t('nav.players'), icon: I.IconPlayers, group: 'general', badge: playersCount },
    { id: 'times', label: t('nav.times'), icon: I.IconTimer, group: 'general' },
    { id: 'logs', label: t('nav.logs'), icon: I.IconTerminal, group: 'general' },

    { id: 'cars',    label: t('nav.cars'),    icon: I.IconCar,     group: 'content' },
    { id: 'tracks',  label: t('nav.tracks'),  icon: I.IconCircuit, group: 'content' },
    { id: 'presets', label: t('nav.presets'), icon: I.IconFolder,  group: 'content', requires: 'presetManage' },
    { id: 'session', label: t('nav.session'), icon: I.IconFlag,    group: 'content' },
    { id: 'mods',    label: t('nav.mods'),    icon: I.IconUpload,  group: 'content' },

    { id: 'config', label: t('nav.config'), icon: I.IconSettings, group: 'admin', requires: 'serverConfig' },
    { id: 'users',  label: t('nav.users'),  icon: I.IconUsers,    group: 'admin', adminOnly: true },
    { id: 'audit',  label: t('nav.audit'),  icon: I.IconHistory,  group: 'admin', requires: 'auditView' },
    // profile is accessible only via the key icon in the footer, not listed in the nav
  ];
  const groups = {
    general: t('group.general'),
    content: t('group.content'),
    admin: t('group.admin'),
  };
  const grouped = Object.keys(groups).map(g => ({
    title: groups[g],
    items: items.filter(i => i.group === g),
  })).filter(g => g.items.length > 0);

  // Auto-close drawer when navigating to a new page on mobile
  const navigate = (id) => { setPage(id); if (onCloseMobile) onCloseMobile(); };

  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onCloseMobile}/>}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="brand">
        <img src="src/assets/icon.png" className="brand-mark" alt="logo"/>
        <div>
          <div className="brand-name">Assetto Server Panel</div>
          <div className="brand-sub" style={{display:'flex', alignItems:'center', gap: 4}}>
            <I.IconOS size={10}/>
            {osInfo ? `${osInfo.name} ${osInfo.version}` : t('sidebar.os')}
          </div>
        </div>
      </div>

      {grouped.map(g => (
        <React.Fragment key={g.title}>
          <div className="nav-section">{g.title}</div>
          {g.items.map(item => {
            const Icon = item.icon;
            const isAdmin = user.role === 'admin';
            const perms = user.permissions || {};
            const disabled = !isAdmin && (
              (item.adminOnly === true) ||
              (item.requires && !perms[item.requires])
            );
            return (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
                onClick={() => !disabled && navigate(item.id)}
                disabled={disabled}
                title={disabled ? t('sidebar.admin_only') : ''}
                aria-current={page === item.id ? 'page' : undefined}
              >
                <span className="nav-icon"><Icon size={15}/></span>
                {item.label}
                {item.badge != null && item.badge > 0 && (
                  <span className="nav-badge">{item.badge}</span>
                )}
                {disabled && <I.IconLock size={11} style={{marginLeft:'auto', color:'var(--text-faint)'}}/>}
              </button>
            );
          })}
        </React.Fragment>
      ))}

      <div style={{marginTop: 'auto'}}>
        <a
          href="https://github.com/ayozetr"
          target="_blank"
          rel="noreferrer"
          style={{
            display:'flex', alignItems:'center', justifyContent:'center', gap: 5,
            fontSize: 10.5, color: 'var(--text-faint)',
            textDecoration: 'none',
            padding: '6px 10px 8px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <I.IconGithub size={11}/>
          {t('sidebar.credit_by')} <strong style={{color:'var(--text-muted)', fontWeight:600}}>ayozetr</strong>
        </a>

        <div className="sidebar-footer" style={{marginTop: 0}}>
          <div className="user-avatar">{(user.name || '?').slice(0,1).toUpperCase()}</div>
          <div className="user-info">
            <div className="user-name">{user.name || '—'}</div>
            <div className="user-role">{user.role === 'admin' ? t('sidebar.role.admin') : t('sidebar.role.user')}</div>
          </div>
          <button className="icon-btn" onClick={() => navigate('profile')} title={t('nav.profile')}>
            <I.IconKey size={15}/>
          </button>
          <button className="icon-btn" onClick={onLogout} title={t('sidebar.logout')}>
            <I.IconLogout size={15}/>
          </button>
        </div>
      </div>
      </aside>
    </>
  );
}

// ──────────────────────────────────────────────────────
// Topbar with server pill + theme toggle
// ──────────────────────────────────────────────────────
function Topbar({ theme, setTheme, server, onServerAction, user, onMenuClick }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const statusLabel = {
    running: t('topbar.running'),
    starting: t('topbar.starting'),
    stopping: t('topbar.stopping'),
    stopped: t('topbar.stopped'),
  }[server.status];
  const dotClass = server.status === 'running' ? 'live'
    : server.status === 'starting' || server.status === 'stopping' ? 'starting'
    : 'stopped';

  return (
    <div className="topbar">
      <button className="hamburger" onClick={onMenuClick} aria-label="Menu" title="Menu">
        <I.IconMenu size={18}/>
      </button>
      <div style={{display:'flex', alignItems:'center', gap: 10, minWidth: 0, flexShrink: 1}}>
        <div className="topbar-title">{t('topbar.server')}</div>
        <div className="server-pill">
          <span className={`dot ${dotClass}`}></span>
          <span>{statusLabel}</span>
          {server.status === 'running' && (
            <span className="muted" style={{borderLeft: '1px solid var(--border)', paddingLeft: 8, marginLeft: 2}}>
              {server.players}/{server.slots} · {server.uptime}
            </span>
          )}
        </div>
      </div>

      <div className="topbar-spacer"></div>

      {(user.role === 'admin' || user.permissions?.serverControl) && (
        <div className="row topbar-actions" style={{gap: 6}}>
          {server.status === 'stopped' && (
            <button className="btn btn-primary btn-sm" onClick={() => onServerAction('start')}>
              <I.IconPlay size={12}/> {t('topbar.start')}
            </button>
          )}
          {server.status === 'running' && (
            <>
              <button className="btn btn-sm" onClick={() => onServerAction('reload')} title={t('topbar.reload_hint')}>
                <I.IconReload size={12}/> {t('topbar.reload')}
              </button>
              <button className="btn btn-sm" onClick={() => onServerAction('restart')} title={t('topbar.restart_hint')}>
                <I.IconPower size={12}/> {t('topbar.restart')}
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => onServerAction('stop')}>
                <I.IconStop size={12}/> {t('topbar.stop')}
              </button>
            </>
          )}
          {(server.status === 'starting' || server.status === 'stopping') && (
            <button className="btn btn-sm" disabled>
              <I.IconRefresh size={12} style={{animation:'spin 1s linear infinite'}}/> {statusLabel}…
            </button>
          )}
        </div>
      )}

      <button
        className="icon-btn"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title={theme === 'dark' ? t('topbar.theme.light') : t('topbar.theme.dark')}
      >
        {theme === 'dark' ? <I.IconSun size={15}/> : <I.IconMoon size={15}/>}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────
// Login screen
// ──────────────────────────────────────────────────────
function Login({ onLogin, setupStatus }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const userRef = useRef(null);
  const passRef = useRef(null);
  // 2FA: when the server replies needsTotp=true the username+password were
  // valid but the account has TOTP enabled. We hide the password field and
  // surface a 6-digit code input instead, then re-submit with the totp value
  // appended to the body. The username and password stay in state so a
  // re-submit doesn't require the user to type them again.
  const [needsTotp, setNeedsTotp] = useState(false);
  const [totp,      setTotp]      = useState('');
  const totpRef = useRef(null);
  // Setup banner: when /api/setup/status returns ready=false the panel is
  // technically up (login still works) but pretty much every page after
  // login will show errors because the AC paths are wrong. Surface the
  // actionable detail here so the operator doesn't have to log in to
  // discover what's missing.
  const setupBanner = setupStatus && setupStatus.ready === false
    ? (
      <div role="alert" style={{
        marginBottom: 18, padding: '12px 14px', borderRadius: 8,
        background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
        border: '1px solid color-mix(in srgb, #f59e0b 40%, transparent)',
        fontSize: 12.5, lineHeight: 1.5,
      }}>
        <div style={{fontWeight: 600, marginBottom: 4, color: '#b45309'}}>
          {t('login.setup_needed') || 'Configuration needed'}
        </div>
        <div style={{color: 'var(--text-muted)'}}>
          {t('login.setup_hint') || 'The panel cannot find one or more AC server paths. Edit your .env file and restart, or run'} <code style={{background:'var(--bg-3)', padding:'1px 5px', borderRadius:3}}>npm run setup</code>.
        </div>
        <ul style={{margin: '6px 0 0 18px', padding: 0, color: 'var(--text-muted)'}}>
          {(setupStatus.issues || []).map(k => {
            const p = setupStatus.paths && setupStatus.paths[k];
            return <li key={k}><strong>{k}</strong>: <span className="mono" style={{fontSize: 11}}>{p?.path || '(unset)'}</span> {p?.missing ? '— missing' : ''}</li>;
          })}
        </ul>
      </div>
    )
    : null;

  const submit = async (e) => {
    e?.preventDefault();
    setError('');
    if (!user) { setError(t('login.err_user')); setTimeout(() => userRef.current?.focus(), 0); return; }
    if (!pass) { setError(t('login.err_pass')); setTimeout(() => passRef.current?.focus(), 0); return; }
    if (needsTotp && !/^\d{6}$/.test(totp)) {
      setError(t('login.err_totp') || '6-digit code required');
      setTimeout(() => totpRef.current?.focus(), 0);
      return;
    }
    setLoading(true);
    try {
      const body = { username: user, password: pass };
      if (needsTotp) body.totp = totp;
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      // Three outcomes: success, "second factor required" (advance UI), or
      // failure. The needsTotp branch returns 200 with ok:false on first
      // attempt (no code yet) and 401 + needsTotp:true on a bad code.
      if (d.ok) {
        onLogin(d.user);
        return;
      }
      if (d.needsTotp) {
        setNeedsTotp(true);
        setTotp('');
        if (d.error) setError(d.error);
        setTimeout(() => totpRef.current?.focus(), 0);
        return;
      }
      setError(d.error || t('login.err_cred'));
    } catch {
      setError(t('login.err_conn'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img src="src/assets/icon.png" className="login-mark" alt="logo"/>
          <div>
            <div className="login-title">{t('login.title')}</div>
            <div className="login-sub">{t('login.subtitle')}</div>
          </div>
        </div>

        {setupBanner}

        <div className="login-fields">
          <div className="field">
            <label className="field-label">{t('login.user')}</label>
            <input
              ref={userRef}
              className="input"
              value={user}
              onChange={(e)=>setUser(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label">{t('login.password')}</label>
            <div style={{position:'relative'}}>
              <input
                ref={passRef}
                className="input"
                type={showPass ? 'text' : 'password'}
                value={pass}
                onChange={(e)=>setPass(e.target.value)}
                placeholder="••••••••"
                style={{paddingRight: 36}}
              />
              <button
                type="button"
                onClick={() => setShowPass(v => !v)}
                aria-label={showPass ? 'Hide password' : 'Show password'}
                title={showPass ? 'Hide' : 'Show'}
                style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}
              >
                {showPass ? <I.IconEyeOff size={15}/> : <I.IconEye size={15}/>}
              </button>
            </div>
          </div>
          {needsTotp && (
            <div className="field">
              <label className="field-label">{t('login.totp') || 'Authenticator code'}</label>
              <input
                ref={totpRef}
                className="input mono"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                style={{fontSize: 16, letterSpacing: '0.18em', maxWidth: 160}}
              />
              <span className="field-hint">{t('login.totp_hint') || '6 digits from your authenticator app.'}</span>
            </div>
          )}
        </div>

        {error && <div style={{fontSize: 12, color: 'var(--red)', marginBottom: 12}}>{error}</div>}

        <button type="submit" className="btn btn-primary" style={{width:'100%', justifyContent:'center', padding: '9px'}} disabled={loading}>
          {loading ? t('login.btn_loading') : t('login.btn')}
        </button>

      </form>
    </div>
  );
}

// ──────────────────────────────────────────────────────
// Forced password change modal — shown while mustChangePassword is set,
// blocks the rest of the UI until the password is changed successfully.
// ──────────────────────────────────────────────────────
function ForcePasswordChange({ user, onDone, onLogout }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [curPw,    setCurPw]    = useState('');
  const [newPw,    setNewPw]    = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [show,     setShow]     = useState(false);
  const [err,      setErr]      = useState('');
  const [busy,     setBusy]     = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setErr('');
    if (!curPw || !newPw || !confirm)             return setErr(t('profile.err_req'));
    if (newPw !== confirm)                         return setErr(t('profile.err_match'));
    if (!window.passesPwPolicy(newPw))             return setErr(t('profile.err_len'));
    if (newPw === curPw)                           return setErr(t('profile.err_diff'));
    setBusy(true);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: curPw, newPassword: newPw }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.ok) onDone();
      else setErr(d.error || t('login.err_cred'));
    } catch {
      setErr(t('login.err_conn'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit} style={{maxWidth: 440}}>
        <div className="login-brand">
          <I.IconKey size={28}/>
          <div>
            <div className="login-title">{t('profile.change_pw')}</div>
            <div className="login-sub">{t('profile.must_change')}</div>
          </div>
        </div>

        <div className="login-fields">
          <div className="field">
            <label className="field-label">{t('profile.cur_pw')}</label>
            <input className="input" type={show ? 'text' : 'password'} value={curPw} onChange={e=>setCurPw(e.target.value)} autoFocus/>
          </div>
          <div className="field">
            <label className="field-label">{t('profile.new_pw')}</label>
            <input className="input" type={show ? 'text' : 'password'} value={newPw} onChange={e=>setNewPw(e.target.value)}/>
          </div>
          <div className="field">
            <label className="field-label">{t('profile.confirm_pw')}</label>
            <div style={{position:'relative'}}>
              <input className="input" type={show ? 'text' : 'password'} value={confirm} onChange={e=>setConfirm(e.target.value)} style={{paddingRight: 36}}/>
              <button type="button" onClick={() => setShow(v => !v)}
                aria-label={show ? 'Hide password' : 'Show password'}
                title={show ? 'Hide' : 'Show'}
                style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}>
                {show ? <I.IconEyeOff size={15}/> : <I.IconEye size={15}/>}
              </button>
            </div>
          </div>
        </div>

        {err && <div style={{fontSize: 12, color: 'var(--red)', marginBottom: 12}}>{err}</div>}

        <div style={{display:'flex', gap: 8}}>
          <button type="button" className="btn" onClick={onLogout} disabled={busy}>
            <I.IconLogout size={13}/> {t('sidebar.logout')}
          </button>
          <button type="submit" className="btn btn-primary" style={{flex: 1, justifyContent:'center', padding: '9px'}} disabled={busy}>
            {busy ? t('login.btn_loading') : t('profile.change_pw')}
          </button>
        </div>
      </form>
    </div>
  );
}

// Focus trap for modals. Mounts: stash the previously-focused element, move
// focus into the modal's first tabbable child. While active: Tab and Shift+Tab
// wrap inside the modal instead of leaking to the page underneath. Unmount:
// restore the original focus so the user lands back on the button they
// pressed to open the modal. Pair with role="dialog" aria-modal="true" on
// the modal's root for the screen-reader half of the contract.
//
// Returns a ref the caller assigns to the modal's outermost element.
function useFocusTrap(active = true) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previouslyFocused = document.activeElement;
    // Move focus inside. Prefer an explicit autoFocus child; fall back to the
    // first tabbable element; fall back to the modal root itself (tabIndex=-1
    // is set inline by the modal so this fallback actually focuses something).
    const focusables = () => node.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    const initial = node.querySelector('[autofocus]') || focusables()[0] || node;
    try { initial.focus(); } catch {}

    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const list = Array.from(focusables());
      if (list.length === 0) { e.preventDefault(); return; }
      const first = list[0];
      const last  = list[list.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !node.contains(document.activeElement)) {
          e.preventDefault(); try { last.focus(); } catch {}
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault(); try { first.focus(); } catch {}
        }
      }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      try { previouslyFocused && previouslyFocused.focus(); } catch {}
    };
  }, [active]);
  return ref;
}

// Accessible switch. The CSS class .switch already produces the visual track
// + thumb; this wrapper adds the ARIA contract and keyboard handlers so the
// control is reachable by tab and triggered by Space/Enter. Use everywhere
// the panel needs a toggle — replaces bare <div className="switch …" onClick>.
function Switch({ on, onChange, disabled, ariaLabel, className = '', style }) {
  const activate = () => { if (!disabled && typeof onChange === 'function') onChange(!on); };
  return (
    <div
      role="switch"
      aria-checked={!!on}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      tabIndex={disabled ? -1 : 0}
      className={`switch ${on ? 'on' : ''} ${className}`.trim()}
      style={{ ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : { cursor: 'pointer' }), ...style }}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          activate();
        }
      }}
    />
  );
}

window.AppShell = { Sidebar, Topbar, Login, ForcePasswordChange, ToastProvider, useToast, Switch, useFocusTrap };
