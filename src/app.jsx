// Main App: state orchestration + routing
const { useState: uS, useEffect: uE, useMemo: uM, useRef: uR } = React;

const PAGES = {
  dashboard: { title: 'Dashboard', component: 'PageDashboard' },
  players:   { title: 'Jugadores', component: 'PagePlayers' },
  times:     { title: 'Tiempos',   component: 'PageTimes' },
  logs:      { title: 'Logs',      component: 'PageLogs' },
  cars:      { title: 'Coches',    component: 'PageCars' },
  tracks:    { title: 'Tramos',    component: 'PageTracks' },
  session:   { title: 'Sesión',    component: 'PageSession' },
  config:    { title: 'Configuración', component: 'PageConfig' },
  users:     { title: 'Usuarios',  component: 'PageUsers' },
  profile:   { title: 'Mi cuenta', component: 'PageProfile' },
};

function App() {
  const { Sidebar, Topbar, Login, ToastProvider, useToast } = window.AppShell;

  const [theme, setTheme] = uS(() => localStorage.getItem('ac-theme') || 'light');
  const [user,  setUser]  = uS(() => {
    try { return JSON.parse(localStorage.getItem('ac-user')); } catch { return null; }
  });
  const [page, setPage] = uS('dashboard');

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

  // Load all data from backend on mount
  uE(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => {
        setConfig(c => ({ ...c, ...d }));
        // Sync current session track from server config
        if (d.track) {
          setSessionCfg(s => ({
            ...s,
            trackId: d.track,
            layout:  d.trackConfig || '',
            carIds:  d.cars?.length ? d.cars : s.carIds,
          }));
        }
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
  }, []);

  // Poll /api/metrics every 4s
  uE(() => {
    const poll = () => {
      fetch('/api/metrics')
        .then(r => r.json())
        .then(d => {
          failCount.current = 0;
          setBackendDown(false);
          setServer(s => ({
            ...s,
            status:    d.running ? (s.status === 'starting' || s.status === 'stopping' ? s.status : 'running') : 'stopped',
            cpu:       d.cpu,
            cpuName:   d.cpuName || s.cpuName,
            ram:       d.ram.used,
            ramTotal:  d.ram.total,
            uptime:    d.uptime,
            liveTrack: d.liveTrack || null,
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
  }, []);

  const serverDisplay = { ...server, cpu: Math.round(server.cpu) };

  if (!user) return <Login onLogin={setUser}/>;

  return (
    <ToastProvider>
      <AppInner
        user={user} setUser={setUser}
        page={page} setPage={setPage}
        theme={theme} setTheme={setTheme}
        server={serverDisplay} setServer={setServer}
        players={players} setPlayers={setPlayers}
        pastPlayers={pastPlayers}
        lapTimes={lapTimes}
        users={users} setUsers={setUsers}
        cars={cars} tracks={tracks}
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
  const { PageDashboard, PagePlayers, PageLogs } = window.AppPagesA;
  const { PageCars, PageTracks, PageSession }    = window.AppPagesB;
  const { PageConfig, PageUsers, PageProfile }   = window.AppPagesC;
  const { PageTimes }                            = window.AppPagesD;
  const toast = useToast();

  const {
    user, page, setPage, theme, setTheme,
    server, setServer, players, setPlayers, pastPlayers,
    lapTimes, users, setUsers, cars, tracks,
    sessionCfg, setSessionCfg, config, setConfig, setUser, osInfo,
    dataLoaded, backendDown,
  } = props;

  const isAdmin = user.role === 'admin';

  const handleServerAction = (action) => {
    if (!isAdmin) { toast.push('No tienes permisos para esta acción', 'warn'); return; }
    if (action === 'reload') {
      toast.push('Recargando configuración…', 'info');
      fetch('/api/server/reload', { method: 'POST' })
        .then(r => r.json())
        .then(d => toast.push(d.error ? `Error: ${d.error}` : 'Señal de recarga enviada', d.error ? 'error' : 'success'))
        .catch(e => toast.push(`Error: ${e.message}`, 'error'));
      return;
    }
    const labels = { start: 'Arrancando', stop: 'Deteniendo', restart: 'Reiniciando' };
    const transitional = action === 'stop' ? 'stopping' : 'starting';
    setServer(s => ({...s, status: transitional}));
    toast.push(`${labels[action]} servidor…`, 'info');
    fetch(`/api/server/${action}`, { method: 'POST' })
      .then(r => r.json())
      .then(d => { if (d.error) toast.push(`Error: ${d.error}`, 'error'); })
      .catch(e => toast.push(`Error de red: ${e.message}`, 'error'));
  };

  const handleKick = (p) => {
    fetch('/api/players/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carId: p.id }),
    }).catch(() => {});
    setPlayers(ps => ps.filter(x => x.id !== p.id));
    setServer(s => ({...s, players: Math.max(0, s.players - 1)}));
    toast.push(`${p.name} expulsado del servidor`, 'success');
  };
  const handleBan = (p) => {
    fetch('/api/players/ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: p.steam }),
    })
      .then(r => r.json())
      .then(d => toast.push(d.error ? `Error al banear: ${d.error}` : `${p.name} añadido a blacklist`, d.error ? 'error' : 'success'))
      .catch(e => toast.push(`Error: ${e.message}`, 'error'));
    setPlayers(ps => ps.filter(x => x.id !== p.id));
    setServer(s => ({...s, players: Math.max(0, s.players - 1)}));
  };

  const handleApplySession = () => {
    fetch('/api/session/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackId: sessionCfg.trackId,
        layout:  sessionCfg.layout || '',
        cars:    sessionCfg.carIds,
      }),
    })
      .then(r => r.json())
      .then(d => toast.push(d.error ? `Error: ${d.error}` : 'Sesión escrita en server_cfg.ini — reinicia para aplicar', d.error ? 'error' : 'success'))
      .catch(e => toast.push(`Error: ${e.message}`, 'error'));
  };
  const handleSaveConfig = () =>
    fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
      .then(r => r.json())
      .then(() => toast.push('Configuración guardada', 'success'))
      .catch(() => { toast.push('Error al guardar configuración', 'error'); throw new Error('save failed'); });

  let content = null;
  if      (page === 'dashboard') content = <PageDashboard server={server} players={players} sessionCfg={sessionCfg} tracks={tracks} cars={cars}/>;
  else if (page === 'players')   content = <PagePlayers players={players} pastPlayers={pastPlayers} server={server} isAdmin={isAdmin} onKick={handleKick} onBan={handleBan}/>;
  else if (page === 'logs')      content = <PageLogs server={server}/>;
  else if (page === 'times')     content = <PageTimes cars={cars} tracks={tracks} lapTimes={lapTimes} lapTimesLoaded={dataLoaded.lapTimes}/>;
  else if (page === 'cars')      content = <PageCars cars={cars} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} carsLoaded={dataLoaded.cars}/>;
  else if (page === 'tracks')    content = <PageTracks tracks={tracks} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} tracksLoaded={dataLoaded.tracks}/>;
  else if (page === 'session')   content = <PageSession tracks={tracks} cars={cars} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} isAdmin={isAdmin} onApply={handleApplySession}/>;
  else if (page === 'config')    content = <PageConfig config={config} setConfig={setConfig} isAdmin={isAdmin} onSave={handleSaveConfig}/>;
  else if (page === 'users')     content = <PageUsers users={users} setUsers={setUsers} isAdmin={isAdmin}/>;
  else if (page === 'profile')   content = <PageProfile user={user}/>;
  else content = <div className="card" style={{margin: '32px 0'}}><div className="empty">Página no encontrada.</div></div>;

  return (
    <div className="app">
      <Sidebar
        page={page} setPage={setPage}
        user={user}
        onLogout={() => { fetch('/api/auth/logout', { method: 'POST' }).catch(()=>{}); setUser(null); }}
        playersCount={server.status === 'running' ? players.length : 0}
        osInfo={osInfo}
      />
      <div className="main">
        <Topbar
          theme={theme} setTheme={setTheme}
          server={server}
          onServerAction={handleServerAction}
          user={user}
        />
        <div className="content">
          {backendDown && (
            <div className="alert-banner error">
              <I.IconX size={14}/>
              Backend no disponible — comprueba que el servidor sigue en ejecución. Los datos mostrados pueden estar desactualizados.
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

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Acento">
        <TweakColor label="Color rojo" value={tw.redHue} onChange={v => setTw('redHue', v)}/>
      </TweakSection>
      <TweakSection label="Forma">
        <TweakSlider label="Radio de bordes" value={tw.radius} onChange={v => setTw('radius', v)} min={0} max={16} step={1} unit="px"/>
      </TweakSection>
      <TweakSection label="Densidad">
        <TweakRadio
          value={tw.density} onChange={v => setTw('density', v)}
          options={[
            { value: 'compact', label: 'Compacto' },
            { value: 'comfy',   label: 'Equilibrado' },
            { value: 'dense',   label: 'Denso' },
          ]}
        />
      </TweakSection>
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
