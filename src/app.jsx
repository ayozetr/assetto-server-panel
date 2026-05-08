// Main App: state orchestration + routing
const { useState: uS, useEffect: uE, useRef: uR } = React;

// Global fetch interceptor — when any /api/ call returns 401 the session is gone
// (expired or revoked). Dispatch a custom event so App can clear user state and
// re-render the Login screen instead of leaving the UI hanging on stale data.
// Login attempts (which legitimately return 401 on bad credentials) are excluded.
if (!window.__acFetchPatched) {
  window.__acFetchPatched = true;
  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/login')) {
        window.dispatchEvent(new CustomEvent('ac-session-expired'));
      }
    } catch {}
    return res;
  };
}

// Error boundary — surfaces render errors instead of leaving a blank page
class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, info: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    this.setState({ info });
    try { console.error('[AppErrorBoundary]', error, info); } catch {}
  }
  reset = () => {
    try { localStorage.removeItem('ac-user'); } catch {}
    this.setState({ error: null, info: null });
    location.reload();
  };
  render() {
    if (!this.state.error) return this.props.children;
    const msg  = (this.state.error && (this.state.error.stack || this.state.error.message)) || String(this.state.error);
    const info = this.state.info && this.state.info.componentStack || '';
    return (
      <div style={{padding:24, fontFamily:'monospace', fontSize:12, color:'#dc2626', background:'#fff', minHeight:'100vh'}}>
        <h2 style={{margin:'0 0 12px'}}>Application crashed</h2>
        <p style={{color:'#444'}}>The UI hit a render error. Reload after clearing local state.</p>
        <pre style={{whiteSpace:'pre-wrap', background:'#fafafa', border:'1px solid #eee', padding:12, borderRadius:6}}>{msg}</pre>
        {info && <pre style={{whiteSpace:'pre-wrap', background:'#fafafa', border:'1px solid #eee', padding:12, borderRadius:6, marginTop:8, color:'#555'}}>{info}</pre>}
        <button onClick={this.reset} style={{marginTop:12, padding:'8px 14px', background:'#dc2626', color:'#fff', border:0, borderRadius:6, cursor:'pointer'}}>
          Clear session and reload
        </button>
      </div>
    );
  }
}

function App() {
  const { Login, ForcePasswordChange, ToastProvider } = window.AppShell;

  const [theme, setTheme] = uS(() => localStorage.getItem('ac-theme') || 'light');
  const [user,  setUser]  = uS(() => {
    try { return JSON.parse(localStorage.getItem('ac-user')); } catch { return null; }
  });
  const [page, setPage] = uS('dashboard');
  const [langNonce, setLangNonce] = uS(0);

  // Force re-render on lang change
  uE(() => {
    const handler = () => setLangNonce(n => n + 1);
    window.addEventListener('ac-lang-change', handler);
    return () => window.removeEventListener('ac-lang-change', handler);
  }, []);

  // Auto-logout when any API call comes back 401 (session expired/revoked)
  uE(() => {
    const handler = () => setUser(null);
    window.addEventListener('ac-session-expired', handler);
    return () => window.removeEventListener('ac-session-expired', handler);
  }, []);

  const [server, setServer] = uS({
    status: 'stopped',
    players: 0,
    slots: 24,
    cpu: 0,
    cpuName: '—',
    ram: 0,
    ramTotal: 0,
    uptime: '—',
    liveTrack: null,
  });
  const [osInfo, setOsInfo] = uS(null);

  const [players,     setPlayers]     = uS([]);
  const [pastPlayers, setPastPlayers] = uS([]);
  const [lapTimes,    setLapTimes]    = uS([]);
  const [users,       setUsers]       = uS([]);

  const [sessionCfg, setSessionCfg] = uS({
    trackId: '',
    layout: '',
    mode: 'Práctica',
    laps: 12,
    slots: 24,
    time: 14,
    weather: 'Soleado',
    airTemp: 24,
    damage: 50,
    abs: true, tc: true, autoShift: false, ideal: false,
    penalties: true, tireWear: true, fuel: true,
    carIds: [],
  });

  const [config, setConfig] = uS({
    name: '', welcome: '',
    tcp: 9600, udp: 9600, http: 8081, tickrate: 18,
    maxClients: 16, publicLobby: false,
    password: '', adminPass: '',
    whitelist: false, autoStart: false, autoRestart: true,
    fuelRate: 100, damage: 100, tyreWear: 100,
    abs: 0, tc: 0, autoclutch: false,
  });

  const [cars,   setCars]   = uS([]);
  const [tracks, setTracks] = uS([]);

  const [dataLoaded, setDataLoaded] = uS({ cars: false, tracks: false, lapTimes: false });
  const [backendDown, setBackendDown] = uS(false);
  const failCount = uR(0);

  // Persist theme & user
  uE(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ac-theme', theme);
  }, [theme]);
  uE(() => {
    if (user) localStorage.setItem('ac-user', JSON.stringify(user));
    else localStorage.removeItem('ac-user');
  }, [user]);

  // Validate server-side session on mount; force re-login if cookie is stale
  uE(() => {
    if (user) {
      fetch('/api/auth/me')
        .then(r => r.json())
        .then(d => {
          if (!d.username) setUser(null);
          // Mirror the server flag in both directions — true → true (forces modal),
          // false → false (clears stale local state). Without this, a user who cleared
          // the flag on a different browser keeps seeing the forced-change modal here.
          else setUser(u => ({ ...u, mustChangePassword: !!d.mustChangePassword }));
        })
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load all data from backend — runs whenever user logs in (user goes from null → truthy)
  uE(() => {
    if (!user) return;

    fetch('/api/config')
      .then(r => r.json())
      .then(d => {
        if (d.error) return;
        setConfig(c => ({ ...c, ...d }));
        setSessionCfg(s => ({
          ...s,
          ...(d.track      ? { trackId: d.track, layout: d.trackConfig || '', carIds: d.cars?.length ? d.cars : s.carIds } : {}),
          ...(d.maxClients ? { slots: d.maxClients } : {}),
        }));
        if (d.maxClients) setServer(s => ({ ...s, slots: d.maxClients }));
      })
      .catch(() => {});

    fetch('/api/results')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setLapTimes(d); })
      .catch(() => {})
      .finally(() => setDataLoaded(d => ({...d, lapTimes: true})));

    fetch('/api/cars')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d) && d.length) setCars(d); })
      .catch(() => {})
      .finally(() => setDataLoaded(d => ({...d, cars: true})));

    fetch('/api/tracks')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d) && d.length) setTracks(d); })
      .catch(() => {})
      .finally(() => setDataLoaded(d => ({...d, tracks: true})));

    fetch('/api/players/history')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setPastPlayers(d); })
      .catch(() => {});

    fetch('/api/panel/users')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setUsers(d); })
      .catch(() => {});

    fetch('/api/panel/settings')
      .then(r => r.json())
      .then(d => { if (d.lang && window.AppI18n) window.AppI18n.setLang(d.lang); })
      .catch(() => {});
  }, [!!user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll /api/metrics every 4s — only while authenticated
  uE(() => {
    if (!user) return;
    const poll = () => {
      fetch('/api/metrics')
        .then(r => r.json())
        .then(d => {
          // Guard against error responses (401, 500, etc.) which lack the metrics shape
          if (!d || d.error || !d.ram) return;
          failCount.current = 0;
          setBackendDown(false);
          setServer(s => ({
            ...s,
            status:    d.running ? 'running' : (s.status === 'starting' ? s.status : 'stopped'),
            cpu:       d.cpu,
            cpuName:   d.cpuName || s.cpuName,
            ram:       d.ram.used,
            ramTotal:  d.ram.total,
            uptime:    d.uptime,
            liveTrack: d.liveTrack || null,
            publicIp:  d.publicIp  || s.publicIp,
            httpPort:  d.httpPort  || s.httpPort,
          }));
          if (d.osInfo) setOsInfo(d.osInfo);
        })
        .catch(() => {
          failCount.current += 1;
          if (failCount.current >= 3) setBackendDown(true);
        });
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [!!user]); // eslint-disable-line react-hooks/exhaustive-deps

  const serverDisplay = { ...server, cpu: Math.round(server.cpu) };

  if (!user) return <Login onLogin={setUser}/>;

  // Block the rest of the panel until the user clears the must_change_password flag.
  // The server enforces the same gate — no admin/data API will respond until flag = 0.
  if (user.mustChangePassword) {
    return (
      <ForcePasswordChange
        user={user}
        onDone={() => setUser(u => ({ ...u, mustChangePassword: false }))}
        onLogout={() => { fetch('/api/auth/logout', { method: 'POST' }).catch(()=>{}); setUser(null); }}
      />
    );
  }

  return (
    <ToastProvider>
      <AppInner
        key={`appinner-${langNonce}`}
        user={user} setUser={setUser}
        page={page} setPage={setPage}
        theme={theme} setTheme={setTheme}
        server={serverDisplay} setServer={setServer}
        players={players} setPlayers={setPlayers}
        pastPlayers={pastPlayers}
        lapTimes={lapTimes}
        users={users} setUsers={setUsers}
        cars={cars} setCars={setCars}
        tracks={tracks} setTracks={setTracks}
        sessionCfg={sessionCfg} setSessionCfg={setSessionCfg}
        config={config} setConfig={setConfig}
        osInfo={osInfo}
        dataLoaded={dataLoaded}
        backendDown={backendDown}
      />
    </ToastProvider>
  );
}

function AppInner(props) {
  const { Sidebar, Topbar, useToast } = window.AppShell;
  const I = window.AppIcons;
  const { PageDashboard, PagePlayers, PageLogs } = window.AppPagesMonitoring;
  const { PageCars, PageTracks, PageSession }    = window.AppPagesContent;
  const { PageConfig, PageUsers, PageProfile, PageAudit } = window.AppPagesSettings;
  const { PageTimes }                            = window.AppPagesLaptimes;
  const { PageMods }                             = window.AppPagesMods;
  const toast = useToast();

  const {
    user, page, setPage, theme, setTheme,
    server, setServer, players, setPlayers, pastPlayers,
    lapTimes, users, setUsers, cars, setCars, tracks, setTracks,
    sessionCfg, setSessionCfg, config, setConfig, setUser, osInfo,
    dataLoaded, backendDown,
  } = props;

  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const isAdmin = user.role === 'admin';

  const handleServerAction = (action) => {
    if (!isAdmin) { toast.push(t('common.no_permissions'), 'warn'); return; }
    const transitional = action === 'stop' ? 'stopping' : 'starting';
    setServer(s => ({...s, status: transitional}));
    const msgMap = {
      start:   t('toast.start_server'),
      stop:    t('toast.stop_server'),
      restart: t('toast.restart_server'),
      reload:  t('toast.reload_config'),
    };
    toast.push(msgMap[action] || msgMap.start, 'info');

    fetch(`/api/server/${action}`, { method: 'POST' })
      .then(async r => {
        let d = {};
        try { d = await r.json(); } catch {}
        if (!r.ok || d.error) {
          // Restore status from next metrics poll instead of staying transitional
          setServer(s => ({...s, status: 'stopped'}));
          toast.push(`${t('common.error')}: ${d.error || ('HTTP ' + r.status)}`, 'error');
          return;
        }
        const okMsg = action === 'stop' ? t('topbar.stopped')
                    : action === 'start' ? t('topbar.running')
                    : t('toast.reload_sent');
        toast.push(okMsg, 'success');
        // Reload current config so UI reflects what's actually live
        if (action === 'restart' || action === 'reload' || action === 'start') {
          fetch('/api/config').then(r => r.json()).then(c => {
            if (c && !c.error) setConfig(prev => ({ ...prev, ...c }));
          }).catch(()=>{});
        }
      })
      .catch(e => {
        setServer(s => ({...s, status: 'stopped'}));
        toast.push(`${t('common.net_error')}: ${e.message}`, 'error');
      });
  };

  const handleKick = (p) => {
    fetch('/api/players/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carId: p.id }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) {
          toast.push(`${t('common.error')}: ${d.error}`, 'error');
        } else {
          setPlayers(ps => ps.filter(x => x.id !== p.id));
          setServer(s => ({...s, players: Math.max(0, s.players - 1)}));
          toast.push(`${p.name} ${t('toast.kick')}`, 'success');
        }
      })
      .catch(e => toast.push(`${t('common.error')}: ${e.message}`, 'error'));
  };

  const handleBan = (p) => {
    fetch('/api/players/ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: p.steam }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) {
          toast.push(`${t('common.error')}: ${d.error}`, 'error');
        } else {
          setPlayers(ps => ps.filter(x => x.id !== p.id));
          setServer(s => ({...s, players: Math.max(0, s.players - 1)}));
          toast.push(`${p.name} ${t('toast.ban')}`, 'success');
        }
      })
      .catch(e => toast.push(`${t('common.error')}: ${e.message}`, 'error'));
  };

  const refreshConfig = () =>
    fetch('/api/config').then(r => r.json()).then(d => {
      if (d && !d.error) {
        setConfig(prev => ({ ...prev, ...d }));
        if (d.track) {
          setSessionCfg(s => ({
            ...s,
            trackId: d.track,
            layout:  d.trackConfig || '',
            carIds:  d.cars?.length ? d.cars : s.carIds,
          }));
        }
      }
    }).catch(()=>{});

  const handleApplySession = () => {
    if (!isAdmin) { toast.push(t('common.no_permissions'), 'warn'); return; }
    const wasRunning = server.status === 'running';
    if (wasRunning) setServer(s => ({...s, status: 'starting'}));
    fetch('/api/session/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackId: sessionCfg.trackId,
        layout:  sessionCfg.layout || '',
        cars:    sessionCfg.carIds,
        slots:   sessionCfg.slots,
        restart: true,
      }),
    })
      .then(async r => {
        let d = {};
        try { d = await r.json(); } catch {}
        if (!r.ok || d.error) {
          if (wasRunning) setServer(s => ({...s, status: 'running'}));
          toast.push(`${t('common.error')}: ${d.error || ('HTTP ' + r.status)}`, 'error');
          return;
        }
        if (sessionCfg.slots) setServer(s => ({ ...s, slots: sessionCfg.slots }));
        if (d.restartError) {
          toast.push(`${t('toast.session_apply')} · ${d.restartError}`, 'warn');
        } else if (d.restarted) {
          toast.push(t('toast.session_apply_restarted') || t('toast.session_apply'), 'success');
        } else {
          toast.push(t('toast.session_apply'), 'success');
        }
        refreshConfig();
      })
      .catch(e => {
        if (wasRunning) setServer(s => ({...s, status: 'running'}));
        toast.push(`${t('common.error')}: ${e.message}`, 'error');
      });
  };

  const handleSaveConfig = (opts = {}) => {
    if (!isAdmin) { toast.push(t('common.no_permissions'), 'warn'); return Promise.reject(new Error('no admin')); }
    const restart = opts.restart === true;
    return fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, restart }),
    })
      .then(async r => {
        if (r.status === 401) { setUser(null); throw new Error('session_expired'); }
        let d = {};
        try { d = await r.json(); } catch {}
        if (!r.ok || d.error) {
          toast.push(`${t('common.error')}: ${d.error || ('HTTP ' + r.status)}`, 'error');
          throw new Error(d.error || 'save failed');
        }
        if (config.maxClients > 0) {
          setServer(s => ({ ...s, slots: config.maxClients }));
          setSessionCfg(s => ({ ...s, slots: config.maxClients }));
        }
        if (d.rejected && d.rejected.length) {
          toast.push(`${t('common.warn') || 'Warning'}: rejected fields: ${d.rejected.join(', ')}`, 'warn');
        }
        if (d.restartError) toast.push(`${t('toast.config_saved')} · ${d.restartError}`, 'warn');
        else if (d.restarted) toast.push(t('toast.config_saved_restarted') || t('toast.config_saved'), 'success');
        else toast.push(t('toast.config_saved'), 'success');
        refreshConfig();
      })
      .catch((e) => {
        if (e.message !== 'save failed' && e.message !== 'session_expired') toast.push(t('common.error'), 'error');
        throw e;
      });
  };

  const refreshContent = React.useCallback(() => {
    fetch('/api/cars').then(r => r.json()).then(d => { if (Array.isArray(d) && d.length) setCars(d); }).catch(() => {});
    fetch('/api/tracks').then(r => r.json()).then(d => { if (Array.isArray(d) && d.length) setTracks(d); }).catch(() => {});
  }, [setCars, setTracks]);

  let content = null;
  if      (page === 'dashboard') content = <PageDashboard server={server} players={players} sessionCfg={sessionCfg} tracks={tracks} cars={cars}/>;
  else if (page === 'players')   content = <PagePlayers players={players} pastPlayers={pastPlayers} server={server} isAdmin={isAdmin} onKick={handleKick} onBan={handleBan}/>;
  else if (page === 'logs')      content = <PageLogs server={server}/>;
  else if (page === 'times')     content = <PageTimes cars={cars} tracks={tracks} lapTimes={lapTimes} lapTimesLoaded={dataLoaded.lapTimes}/>;
  else if (page === 'cars')      content = <PageCars cars={cars} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} carsLoaded={dataLoaded.cars}/>;
  else if (page === 'tracks')    content = <PageTracks tracks={tracks} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} tracksLoaded={dataLoaded.tracks}/>;
  else if (page === 'mods')      content = <PageMods isAdmin={isAdmin} refreshContent={refreshContent}/>;
  else if (page === 'session')   content = <PageSession tracks={tracks} cars={cars} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} isAdmin={isAdmin} onApply={handleApplySession}/>;
  else if (page === 'config')    content = <PageConfig config={config} setConfig={setConfig} isAdmin={isAdmin} onSave={handleSaveConfig}/>;
  else if (page === 'users')     content = <PageUsers users={users} setUsers={setUsers} isAdmin={isAdmin}/>;
  else if (page === 'audit')     content = <PageAudit/>;
  else if (page === 'profile')   content = <PageProfile user={user} setUser={setUser}/>;
  else content = <div className="card" style={{margin: '32px 0'}}><div className="empty">{t('common.not_found')}</div></div>;

  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  // Auto-close drawer when crossing the desktop breakpoint
  React.useEffect(() => {
    const onResize = () => { if (window.innerWidth > 900 && mobileMenuOpen) setMobileMenuOpen(false); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mobileMenuOpen]);

  // Browser online/offline detection — separate from backendDown (which polls /api/metrics).
  // Lets the user know the SW is serving cached data when their network drops.
  const [offline, setOffline] = React.useState(typeof navigator !== 'undefined' && navigator.onLine === false);
  React.useEffect(() => {
    const onOnline  = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  // Esc closes the mobile drawer
  React.useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMobileMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileMenuOpen]);

  return (
    <div className="app">
      <a href="#ac-main-content" className="skip-link">Skip to main content</a>
      <Sidebar
        page={page} setPage={setPage}
        user={user}
        onLogout={() => { fetch('/api/auth/logout', { method: 'POST' }).catch(()=>{}); setUser(null); }}
        playersCount={server.status === 'running' ? players.length : 0}
        osInfo={osInfo}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />
      <div className="main">
        <Topbar
          theme={theme} setTheme={setTheme}
          server={server}
          onServerAction={handleServerAction}
          user={user}
          onMenuClick={() => setMobileMenuOpen(o => !o)}
        />
        <div className="content" id="ac-main-content">
          {offline && (
            <div className="alert-banner warn" role="status" aria-live="polite">
              <I.IconAlertTriangle size={14}/>
              {t('common.offline') || 'You are offline — data shown may be stale.'}
            </div>
          )}
          {!offline && backendDown && (
            <div className="alert-banner error">
              <I.IconX size={14}/>
              {t('common.backend_down')}
            </div>
          )}
          {content}
        </div>
      </div>
      <TweaksUI/>
    </div>
  );
}

// Tweaks panel
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "redHue": "#dc2626",
  "radius": 8,
  "density": "comfy",
  "sidebarStyle": "light"
}/*EDITMODE-END*/;

function TweaksUI() {
  const { useTweaks, TweaksPanel, TweakSection, TweakColor, TweakSlider, TweakRadio } = window;
  const [tw, setTw] = useTweaks(TWEAK_DEFAULTS);

  uE(() => {
    document.documentElement.style.setProperty('--red', tw.redHue);
    document.documentElement.style.setProperty('--red-600', tw.redHue);
    document.documentElement.style.setProperty('--radius', tw.radius + 'px');
    document.documentElement.style.setProperty('--radius-sm', Math.max(2, tw.radius - 2) + 'px');
    document.documentElement.style.setProperty('--radius-lg', (tw.radius + 4) + 'px');

    if (tw.density === 'compact') {
      document.documentElement.style.fontSize = '13px';
    } else if (tw.density === 'dense') {
      document.documentElement.style.fontSize = '12.5px';
    } else {
      document.documentElement.style.fontSize = '14px';
    }

    if (tw.sidebarStyle === 'dark') {
      document.documentElement.style.setProperty('--sidebar-override', 'true');
    }
  }, [tw]);

  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;

  return (
    <TweaksPanel title={t('tweaks.title')}>
      <TweakSection label={t('tweaks.accent')}>
        <TweakColor label={t('tweaks.red')} value={tw.redHue} onChange={v => setTw('redHue', v)}/>
      </TweakSection>
      <TweakSection label={t('tweaks.shape')}>
        <TweakSlider label={t('tweaks.radius')} value={tw.radius} onChange={v => setTw('radius', v)} min={0} max={16} step={1} unit="px"/>
      </TweakSection>
      <TweakSection label={t('tweaks.density')}>
        <TweakRadio
          value={tw.density} onChange={v => setTw('density', v)}
          options={[
            { value: 'compact', label: t('tweaks.compact') },
            { value: 'comfy',   label: t('tweaks.comfy') },
            { value: 'dense',   label: t('tweaks.dense') },
          ]}
        />
      </TweakSection>
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <AppErrorBoundary><App/></AppErrorBoundary>
);
