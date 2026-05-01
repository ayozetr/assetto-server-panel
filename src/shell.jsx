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
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), 3200);
  };
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {list.map(t => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'success' && <I.IconCheck size={14}/>}
            {t.kind === 'warn' && <I.IconBell size={14}/>}
            {t.kind === 'info' && <I.IconBell size={14}/>}
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
  const items = [
    { id: 'dashboard', label: 'Dashboard', icon: I.IconDashboard, group: 'general' },
    { id: 'players', label: 'Jugadores', icon: I.IconPlayers, group: 'general', badge: playersCount },
    { id: 'times', label: 'Tiempos', icon: I.IconTimer, group: 'general' },
    { id: 'logs', label: 'Logs', icon: I.IconTerminal, group: 'general' },

    { id: 'cars', label: 'Coches', icon: I.IconCar, group: 'content' },
    { id: 'tracks', label: 'Tramos', icon: I.IconTrack, group: 'content' },
    { id: 'session', label: 'Sesión', icon: I.IconFlag, group: 'content' },

    { id: 'config', label: 'Configuración', icon: I.IconSettings, group: 'admin', adminOnly: true },
    { id: 'users', label: 'Usuarios', icon: I.IconUsers, group: 'admin', adminOnly: true },
  ];
  const groups = {
    general: 'Operación',
    content: 'Contenido',
    admin: 'Administración',
  };
  const grouped = Object.keys(groups).map(g => ({
    title: groups[g],
    items: items.filter(i => i.group === g),
  }));

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">AC</div>
        <div>
          <div className="brand-name">Assetto Server</div>
          <div className="brand-sub" style={{display:'flex', alignItems:'center', gap: 4}}>
            <I.IconOS size={10}/>
            {osInfo ? `${osInfo.name} ${osInfo.version}` : 'Linux'}
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
                title={disabled ? 'Solo administradores' : ''}
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
          <div className="user-role">{user.role === 'admin' ? 'Administrador' : 'Usuario'}</div>
        </div>
        <button className="icon-btn" onClick={onLogout} title="Cerrar sesión">
          <I.IconLogout size={15}/>
        </button>
      </div>
    </aside>
  );
}

// ──────────────────────────────────────────────────────
// Topbar with server pill + theme toggle
// ──────────────────────────────────────────────────────
function Topbar({ pageTitle, theme, setTheme, server, onServerAction, user }) {
  const statusLabel = {
    running: 'En ejecución',
    starting: 'Arrancando',
    stopping: 'Deteniendo',
    stopped: 'Detenido',
  }[server.status];
  const dotClass = server.status === 'running' ? 'live'
    : server.status === 'starting' || server.status === 'stopping' ? 'starting'
    : 'stopped';

  return (
    <div className="topbar">
      <div className="topbar-title">{pageTitle}</div>
      <div className="server-pill">
        <span className={`dot ${dotClass}`}></span>
        <span>{statusLabel}</span>
        {server.status === 'running' && (
          <span className="muted" style={{borderLeft: '1px solid var(--border)', paddingLeft: 8, marginLeft: 2}}>
            {server.players}/{server.slots} · {server.uptime}
          </span>
        )}
      </div>

      <div className="topbar-spacer"></div>

      {user.role === 'admin' && (
        <div className="row" style={{gap: 6}}>
          {server.status === 'stopped' && (
            <button className="btn btn-primary btn-sm" onClick={() => onServerAction('start')}>
              <I.IconPlay size={12}/> Arrancar
            </button>
          )}
          {server.status === 'running' && (
            <>
              <button className="btn btn-sm" onClick={() => onServerAction('reload')} title="Recargar config sin reinicio">
                <I.IconReload size={12}/> Recargar
              </button>
              <button className="btn btn-sm" onClick={() => onServerAction('restart')} title="Reiniciar el proceso del servidor">
                <I.IconPower size={12}/> Reiniciar
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => onServerAction('stop')}>
                <I.IconStop size={12}/> Parar
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
        title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
      >
        {theme === 'dark' ? <I.IconSun size={15}/> : <I.IconMoon size={15}/>}
      </button>
      <button className="icon-btn" title="Notificaciones">
        <I.IconBell size={15}/>
      </button>

      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────
// Login screen
// ──────────────────────────────────────────────────────
function Login({ onLogin }) {
  const [user, setUser] = useState('admin');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = (e) => {
    e?.preventDefault();
    setError('');
    if (!user) { setError('Introduce un usuario'); return; }
    if (!pass) { setError('Introduce una contraseña'); return; }
    setLoading(true);
    setTimeout(() => {
      const role = (user === 'admin' || user === 'mattia') ? 'admin' : 'user';
      onLogin({ name: user, role });
      setLoading(false);
    }, 500);
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <div className="login-mark">AC</div>
          <div>
            <div className="login-title">Assetto Server Panel</div>
            <div className="login-sub">Inicia sesión para continuar</div>
          </div>
        </div>

        <div className="login-fields">
          <div className="field">
            <label className="field-label">Usuario</label>
            <input
              className="input"
              value={user}
              onChange={(e)=>setUser(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label">Contraseña</label>
            <input
              className="input"
              type="password"
              value={pass}
              onChange={(e)=>setPass(e.target.value)}
              placeholder="••••••••"
            />
          </div>
        </div>

        {error && <div style={{fontSize: 12, color: 'var(--red)', marginBottom: 12}}>{error}</div>}

        <button type="submit" className="btn btn-primary" style={{width:'100%', justifyContent:'center', padding: '9px'}} disabled={loading}>
          {loading ? 'Entrando…' : 'Entrar'}
        </button>

        <div className="login-hint">
          Demo · entra con <code>admin</code> (admin) o <code>jorge_p</code> (user) · cualquier contraseña
        </div>
      </form>
    </div>
  );
}

window.AppShell = { Sidebar, Topbar, Login, ToastProvider, useToast };
