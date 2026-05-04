// Sidebar + Topbar + Toast system + Login screen
const { useState, useEffect, useRef, useMemo, createContext, useContext } = React;
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
      <div className="toast-wrap">
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
function Sidebar({ page, setPage, user, onLogout, playersCount, osInfo }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const items = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: I.IconDashboard, group: 'general' },
    { id: 'players', label: t('nav.players'), icon: I.IconPlayers, group: 'general', badge: playersCount },
    { id: 'times', label: t('nav.times'), icon: I.IconTimer, group: 'general' },
    { id: 'logs', label: t('nav.logs'), icon: I.IconTerminal, group: 'general' },

    { id: 'cars', label: t('nav.cars'), icon: I.IconCar, group: 'content' },
    { id: 'tracks', label: t('nav.tracks'), icon: I.IconTrack, group: 'content' },
    { id: 'mods', label: t('nav.mods'), icon: I.IconUpload, group: 'content', adminOnly: true },
    { id: 'session', label: t('nav.session'), icon: I.IconFlag, group: 'content' },

    { id: 'config', label: t('nav.config'), icon: I.IconSettings, group: 'admin', adminOnly: true },
    { id: 'users', label: t('nav.users'), icon: I.IconUsers, group: 'admin', adminOnly: true },
    { id: 'profile', label: t('nav.profile'), icon: I.IconKey, group: 'account' },
  ];
  const groups = {
    general: t('group.general'),
    content: t('group.content'),
    admin: t('group.admin'),
    account: t('group.account'),
  };
  const grouped = Object.keys(groups).map(g => ({
    title: groups[g],
    items: items.filter(i => i.group === g),
  }));

  return (
    <aside className="sidebar">
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
            const disabled = item.adminOnly && !isAdmin;
            return (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
                onClick={() => !disabled && setPage(item.id)}
                disabled={disabled}
                title={disabled ? t('sidebar.admin_only') : ''}
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

      <div className="sidebar-footer">
        <div className="user-avatar">{user.name.slice(0,1).toUpperCase()}</div>
        <div className="user-info">
          <div className="user-name">{user.name}</div>
          <div className="user-role">{user.role === 'admin' ? t('sidebar.role.admin') : t('sidebar.role.user')}</div>
        </div>
        <button className="icon-btn" onClick={() => setPage('profile')} title={t('nav.profile')}>
          <I.IconKey size={15}/>
        </button>
        <button className="icon-btn" onClick={onLogout} title={t('sidebar.logout')}>
          <I.IconLogout size={15}/>
        </button>
      </div>
    </aside>
  );
}

// ──────────────────────────────────────────────────────
// Topbar with server pill + theme toggle
// ──────────────────────────────────────────────────────
function Topbar({ theme, setTheme, server, onServerAction, user }) {
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
      <div style={{display:'flex', alignItems:'center', gap: 10}}>
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

      {user.role === 'admin' && (
        <div className="row" style={{gap: 6}}>
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
function Login({ onLogin }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [user, setUser] = useState('admin');
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const userRef = useRef(null);
  const passRef = useRef(null);

  const submit = async (e) => {
    e?.preventDefault();
    setError('');
    if (!user) { setError(t('login.err_user')); setTimeout(() => userRef.current?.focus(), 0); return; }
    if (!pass) { setError(t('login.err_pass')); setTimeout(() => passRef.current?.focus(), 0); return; }
    setLoading(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const d = await r.json();
      if (d.ok) {
        onLogin(d.user);
      } else {
        setError(d.error || t('login.err_cred'));
      }
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
                style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}
              >
                {showPass ? <I.IconEyeOff size={15}/> : <I.IconEye size={15}/>}
              </button>
            </div>
          </div>
        </div>

        {error && <div style={{fontSize: 12, color: 'var(--red)', marginBottom: 12}}>{error}</div>}

        <button type="submit" className="btn btn-primary" style={{width:'100%', justifyContent:'center', padding: '9px'}} disabled={loading}>
          {loading ? t('login.btn_loading') : t('login.btn')}
        </button>

        <div className="login-hint">
          {t('login.hint')}
        </div>
      </form>
    </div>
  );
}

window.AppShell = { Sidebar, Topbar, Login, ToastProvider, useToast };
