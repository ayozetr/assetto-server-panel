// Main App: state orchestration + routing
const { useState: uS, useEffect: uE, useMemo: uM } = React;

const PAGES = {
  dashboard: { title: 'Dashboard', component: 'PageDashboard' },
  players: { title: 'Jugadores', component: 'PagePlayers' },
  times: { title: 'Tiempos', component: 'PageTimes' },
  logs: { title: 'Logs', component: 'PageLogs' },
  cars: { title: 'Coches', component: 'PageCars' },
  tracks: { title: 'Tramos', component: 'PageTracks' },
  session: { title: 'Sesión', component: 'PageSession' },
  config: { title: 'Configuración', component: 'PageConfig' },
  users: { title: 'Usuarios', component: 'PageUsers' },
};

function App() {
  const { Sidebar, Topbar, Login, ToastProvider, useToast } = window.AppShell;

  const [theme, setTheme] = uS(() => localStorage.getItem('ac-theme') || 'light');
  const [user, setUser] = uS(() => {
    try { return JSON.parse(localStorage.getItem('ac-user')); } catch { return null; }
  });
  const [page, setPage] = uS('dashboard');

  // Server state simulation
  const [server, setServer] = uS({
    status: 'running', // running | starting | stopping | stopped
    players: 6,
    slots: 24,
    cpu: 28,
    cpuName: 'AMD Ryzen 7 5800X · 8c/16t @ 3.8GHz',
    ram: 1284,
    uptime: '2h 14m',
  });

  const [players, setPlayers] = uS(window.AppData.PLAYERS_LIVE);
  const [users, setUsers] = uS(window.AppData.USERS_INITIAL);

  const [sessionCfg, setSessionCfg] = uS({
    trackId: 'ks_spa',
    layout: 'Grand Prix',
    mode: 'Práctica',
    laps: 12,
    slots: 24,
    time: 14,
    weather: 'Soleado',
    airTemp: 24,
    damage: 50,
    abs: true, tc: true, autoShift: false, ideal: false,
    penalties: true, tireWear: true, fuel: true,
    carIds: ['ks_porsche_911_gt3_r_2016', 'ks_ferrari_488_gt3', 'ks_lamborghini_huracan_gt3', 'ks_audi_r8_lms_2016', 'ks_mclaren_650_gt3'],
  });

  const [config, setConfig] = uS({
    name: 'AC Server — Liga Iberica',
    description: 'Servidor privado de la liga. Práctica abierta los miércoles, carrera el sábado a las 22:00 CET.',
    welcome: '¡Bienvenido! Respeta a los demás pilotos.',
    tcp: 9600, udp: 9600, http: 8081, tickrate: 22,
    publicLobby: false,
    password: '',
    adminPass: 'kunos1234',
    whitelist: false,
    path: '/srv/assetto',
    binPath: '/srv/assetto/ac_server/acServer',
    contentPath: '/srv/assetto/content',
    cfgPath: '/srv/assetto/cfg',
    resultsPath: '/srv/assetto/ac_server/results',
    logsPath: '/srv/assetto/ac_server/logs',
    dbPath: '/srv/assetto/ac_server/tiempos.db',
    sysUser: 'administrador',
    autoStart: true,
    autoRestart: true,
  });

  // Persist theme & user
  uE(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ac-theme', theme);
  }, [theme]);
  uE(() => {
    if (user) localStorage.setItem('ac-user', JSON.stringify(user));
    else localStorage.removeItem('ac-user');
  }, [user]);

  // Live tick: update CPU/RAM/uptime/players
  uE(() => {
    if (server.status !== 'running') return;
    const id = setInterval(() => {
      setServer(s => ({
        ...s,
        cpu: Math.max(8, Math.min(85, s.cpu + (Math.random() - 0.5) * 8)),
        ram: Math.max(900, Math.min(2400, s.ram + Math.round((Math.random() - 0.5) * 60))),
      }));
      setPlayers(ps => ps.map(p => ({ ...p, ping: Math.max(8, Math.min(180, p.ping + Math.round((Math.random()-0.5)*8))) })));
    }, 1500);
    return () => clearInterval(id);
  }, [server.status]);

  // Round CPU
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
        users={users} setUsers={setUsers}
        sessionCfg={sessionCfg} setSessionCfg={setSessionCfg}
        config={config} setConfig={setConfig}
      />
    </ToastProvider>
  );
}

function AppInner(props) {
  const { Sidebar, Topbar, useToast } = window.AppShell;
  const { PageDashboard, PagePlayers, PageLogs } = window.AppPagesA;
  const { PageCars, PageTracks, PageSession } = window.AppPagesB;
  const { PageConfig, PageUsers } = window.AppPagesC;
  const { PageTimes } = window.AppPagesD;
  const toast = useToast();

  const { user, page, setPage, theme, setTheme, server, setServer, players, setPlayers,
          users, setUsers, sessionCfg, setSessionCfg, config, setConfig, setUser } = props;

  const isAdmin = user.role === 'admin';

  const handleServerAction = (action) => {
    if (!isAdmin) { toast.push('No tienes permisos para esta acción', 'warn'); return; }
    if (action === 'start') {
      setServer(s => ({...s, status: 'starting'}));
      toast.push('Arrancando servidor…', 'info');
      setTimeout(() => {
        setServer(s => ({...s, status: 'running', uptime: '0h 00m', cpu: 22, ram: 1100, players: players.length}));
        toast.push('Servidor arrancado correctamente', 'success');
      }, 1800);
    } else if (action === 'stop') {
      setServer(s => ({...s, status: 'stopping'}));
      toast.push('Deteniendo servidor…', 'info');
      setTimeout(() => {
        setServer(s => ({...s, status: 'stopped', players: 0, cpu: 0, ram: 0, uptime: '—'}));
        toast.push('Servidor detenido', 'success');
      }, 1400);
    } else if (action === 'restart') {
      setServer(s => ({...s, status: 'stopping'}));
      toast.push('Reiniciando servidor…', 'info');
      setTimeout(() => setServer(s => ({...s, status: 'starting'})), 1200);
      setTimeout(() => {
        setServer(s => ({...s, status: 'running', uptime: '0h 00m'}));
        toast.push('Servidor reiniciado', 'success');
      }, 2600);
    } else if (action === 'reload') {
      toast.push('Recargando configuración…', 'info');
      setTimeout(() => toast.push('Configuración recargada sin reinicio', 'success'), 800);
    }
  };

  const handleKick = (p) => {
    setPlayers(ps => ps.filter(x => x.id !== p.id));
    setServer(s => ({...s, players: Math.max(0, s.players - 1)}));
    toast.push(`${p.name} expulsado del servidor`, 'success');
  };
  const handleBan = (p) => {
    setPlayers(ps => ps.filter(x => x.id !== p.id));
    setServer(s => ({...s, players: Math.max(0, s.players - 1)}));
    toast.push(`${p.name} baneado permanentemente`, 'success');
  };

  const handleApplySession = () => {
    toast.push('Sesión aplicada — reinicio en 5s', 'success');
  };
  const handleSaveConfig = () => {
    toast.push('Configuración guardada', 'success');
  };

  const cars = window.AppData.CARS;
  const tracks = window.AppData.TRACKS;

  let content = null;
  if (page === 'dashboard') content = <PageDashboard server={server} players={players} sessionCfg={sessionCfg} tracks={tracks} cars={cars}/>;
  else if (page === 'players') content = <PagePlayers players={players} pastPlayers={window.AppData.PLAYERS_PAST} server={server} isAdmin={isAdmin} onKick={handleKick} onBan={handleBan}/>;
  else if (page === 'logs') content = <PageLogs server={server}/>;
  else if (page === 'times') content = <PageTimes cars={cars} tracks={tracks} lapTimes={window.AppData.LAP_TIMES}/>;
  else if (page === 'cars') content = <PageCars cars={cars} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg}/>;
  else if (page === 'tracks') content = <PageTracks tracks={tracks} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg}/>;
  else if (page === 'session') content = <PageSession tracks={tracks} cars={cars} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} isAdmin={isAdmin} onApply={handleApplySession}/>;
  else if (page === 'config') content = <PageConfig config={config} setConfig={setConfig} isAdmin={isAdmin} onSave={handleSaveConfig}/>;
  else if (page === 'users') content = <PageUsers users={users} setUsers={setUsers} isAdmin={isAdmin}/>;

  return (
    <div className="app">
      <Sidebar
        page={page} setPage={setPage}
        user={user}
        onLogout={() => setUser(null)}
        playersCount={server.status === 'running' ? players.length : 0}
      />
      <div className="main">
        <Topbar
          pageTitle={PAGES[page].title}
          theme={theme} setTheme={setTheme}
          server={server}
          onServerAction={handleServerAction}
          user={user}
        />
        <div className="content">{content}</div>
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

    // Sidebar style: dark = always dark sidebar
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
            { value: 'comfy', label: 'Equilibrado' },
            { value: 'dense', label: 'Denso' },
          ]}
        />
      </TweakSection>
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
