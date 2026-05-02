// Pages: Dashboard, Players, Logs
const { useState, useEffect, useRef, useMemo } = React;
const I2 = window.AppIcons;

// Dashboard
function PageDashboard({ server, players, sessionCfg, tracks, cars }) {
  const track = tracks.find(t => t.id === sessionCfg.trackId) || tracks[0];
  const carsCount = sessionCfg.carIds.length;

  const [activity, setActivity] = useState([]);
  useEffect(() => {
    fetch('/api/logs?n=80')
      .then(r => r.json())
      .then(d => {
        const notable = (d.lines || []).filter(l => l.lvl !== 'info' || /connected|joined|lap|session|server/i.test(l.msg));
        setActivity(notable.slice(-8).reverse().slice(0, 5));
      })
      .catch(() => {});
  }, []);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-sub">Resumen del servidor en tiempo real.</p>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">Estado</div>
          <div className="kpi-value" style={{fontSize: 20, paddingTop: 4}}>
            {server.status === 'running' && <span style={{color: '#16a34a'}}>● En ejecución</span>}
            {server.status === 'stopped' && <span style={{color: 'var(--text-muted)'}}>● Detenido</span>}
            {(server.status === 'starting' || server.status === 'stopping') && <span style={{color: '#f59e0b'}}>● {server.status === 'starting' ? 'Arrancando' : 'Deteniendo'}</span>}
          </div>
          <div className="kpi-meta">Uptime: {server.uptime}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Jugadores</div>
          <div className="kpi-value">{server.players}<span className="unit">/ {server.slots}</span></div>
          <div className="bar"><div className="bar-fill" style={{width: `${(server.players/server.slots)*100}%`}}></div></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">CPU</div>
          <div className="kpi-value">{server.cpu}<span className="unit">%</span></div>
          <div className="kpi-meta" title={server.cpuName} style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
            <I2.IconChip size={10} style={{verticalAlign:'-1px', marginRight: 4}}/>{server.cpuName}
          </div>
          <div className="bar" style={{marginTop: 6}}><div className="bar-fill" style={{width: `${server.cpu}%`}}></div></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">RAM</div>
          <div className="kpi-value">{server.ram}<span className="unit">MB</span></div>
          <div className="kpi-meta">de {server.ramTotal || '—'} MB totales</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <I2.IconFlag size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Sesión actual</div>
          </div>
          <div className="card-body">
            {!track ? (
              <div className="muted" style={{fontSize: 13, padding: '4px 0 8px'}}>Cargando información de sesión…</div>
            ) : (
              <>
                <div className="row" style={{gap: 14}}>
                  <div style={{width: 120, height: 68, borderRadius: 6, overflow:'hidden', background: 'var(--bg-3)'}}>
                    <img src={track.thumb} style={{width:'100%', height:'100%', objectFit:'cover'}} alt=""
                      onError={e => { e.target.style.display='none'; }}/>
                  </div>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: 14, fontWeight: 600}}>{track.name}</div>
                    <div style={{fontSize: 12, color: 'var(--text-muted)'}}>{track.city || track.loc} · {track.length} km · {sessionCfg.layout}</div>
                    <div className="row" style={{marginTop: 8, gap: 6}}>
                      <span className="badge badge-red">{sessionCfg.mode}</span>
                      <span className="badge">{carsCount} {carsCount === 1 ? 'coche' : 'coches'}</span>
                      <span className="badge">{sessionCfg.laps} vueltas</span>
                    </div>
                  </div>
                </div>
                <div className="divider"></div>
                <div className="grid-3">
                  <div>
                    <div className="field-label">Hora</div>
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{sessionCfg.time}:00</div>
                  </div>
                  <div>
                    <div className="field-label">Clima</div>
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{sessionCfg.weather}</div>
                  </div>
                  <div>
                    <div className="field-label">Daños</div>
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{sessionCfg.damage}%</div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <I2.IconPlayers size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Jugadores conectados</div>
            <span className="badge right">{players.length}</span>
          </div>
          {players.length === 0 ? (
            <div className="empty">Nadie está jugando ahora mismo.</div>
          ) : (
            <div>
              {players.slice(0, 5).map((p, i) => (
                <div className="player-row" key={p.id}>
                  <div className={`player-pos ${i === 0 ? 'p1' : ''}`}>{i + 1}</div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div className="player-name">{p.name}</div>
                    <div className="player-car">{p.car}</div>
                  </div>
                  <div className="mono muted">{p.best}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{marginTop: 16}}>
        <div className="card">
          <div className="card-header">
            <I2.IconClock size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Actividad reciente</div>
          </div>
          {activity.length === 0 ? (
            <div className="empty" style={{padding: '28px 20px'}}>Sin actividad registrada.</div>
          ) : (
            <div style={{padding: '4px 0'}}>
              {activity.map((it, i) => {
                const dotColor = it.lvl === 'ok' ? '#16a34a' : it.lvl === 'error' ? 'var(--red)' : it.lvl === 'warn' ? '#f59e0b' : 'var(--text-faint)';
                return (
                  <div key={it.id} style={{display:'flex', gap: 12, padding: '9px 18px', borderBottom: i < activity.length - 1 ? '1px solid var(--border)' : 'none', alignItems:'center', overflow:'hidden'}}>
                    <span style={{width: 6, height: 6, borderRadius: 50, background: dotColor, flexShrink: 0}}></span>
                    <span style={{fontSize: 13, flex: 1, minWidth: 0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={it.msg}>{it.msg}</span>
                    {it.time && <span className="muted" style={{fontSize: 11.5, flexShrink: 0}}>{it.time}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const fmtMs = window.AppUtils.fmtMs;

// Players page
function PagePlayers({ players: initialPlayers, pastPlayers, server, isAdmin, onKick, onBan }) {
  const [players, setPlayers] = useState(initialPlayers);
  const [historySearch, setHistorySearch] = useState('');
  useEffect(() => {
    if (server.status !== 'running') return;
    const load = () => {
      fetch('/api/players')
        .then(r => r.json())
        .then(d => {
          if (d && d.length) setPlayers(d);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [server.status]);

  const I2P = window.AppIcons;
  const filteredPast = historySearch
    ? pastPlayers.filter(p => p.name.toLowerCase().includes(historySearch.toLowerCase()))
    : pastPlayers;
  const renderPast = (
    <div style={{marginTop: 20}}>
      <div className="card">
        <div className="card-header">
          <I2P.IconHistory size={14} style={{color:'var(--red)'}}/>
          <div className="card-title">Jugadores anteriores</div>
          <span className="badge right">{filteredPast.length}</span>
          <div className="search right" style={{maxWidth:200}}>
            <I2P.IconSearch size={12} className="search-icon"/>
            <input className="input" placeholder="Buscar jugador…" value={historySearch}
              onChange={e=>setHistorySearch(e.target.value)} style={{height:28,fontSize:12}}/>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Último coche</th>
              <th style={{width: 80}}>Sesiones</th>
              <th style={{width: 80}}>Vueltas</th>
              <th style={{width: 110}}>Mejor vuelta</th>
              <th style={{width: 100}}>Tiempo total</th>
              <th style={{width: 160}}>Última conexión</th>
              {isAdmin && <th style={{width: 80}}></th>}
            </tr>
          </thead>
          <tbody>
            {filteredPast.map(p => {
              const flagUrl = (window.AppUtils || {}).nationFlag?.(p.nation);
              return (
              <tr key={p.id}>
                <td>
                  <div className="row" style={{gap: 10}}>
                    <div className="user-avatar" style={{width: 26, height: 26, fontSize: 11, background: 'var(--bg-3)', color: 'var(--text-muted)'}}>
                      {p.name.slice(0,1).toUpperCase()}
                    </div>
                    <div>
                      <div className="row" style={{gap: 5, alignItems:'center'}}>
                        <span className="player-name">{p.name}</span>
                        {flagUrl && <img src={flagUrl} alt={p.nation} title={p.nation} style={{height:9, width:'auto', borderRadius:1, opacity:0.75}} onError={e=>{e.target.style.display='none'}}/>}
                      </div>
                      <div className="row" style={{gap:4, alignItems:'center', marginTop:2}}>
                        <div className="mono" style={{fontSize: 10.5, color: 'var(--text-faint)'}}>{p.steam}</div>
                        {p.steam && (
                          <a href={`https://steamcommunity.com/profiles/${p.steam}`} target="_blank" rel="noreferrer"
                            style={{display:'flex', color:'var(--text-faint)', opacity:0.7, lineHeight:1}}
                            title="Ver perfil de Steam">
                            <I2P.IconSteam size={11}/>
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="muted">{p.car}</td>
                <td>{p.sessions}</td>
                <td>{p.laps}</td>
                <td className="mono">{fmtMs(p.bestMs)}</td>
                <td className="mono muted">{p.totalTime}</td>
                <td className="mono muted" style={{fontSize: 12}}>{p.lastSeen}</td>
                {isAdmin && (
                  <td><button className="btn btn-sm btn-danger">Ban</button></td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  if (server.status !== 'running') {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Jugadores</h1>
          <p className="page-sub">Conectados al servidor en este momento.</p>
        </div>
        <div className="card">
          <div className="empty">El servidor no está en ejecución.</div>
        </div>
        {renderPast}
      </>
    );
  }
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Jugadores</h1>
        <p className="page-sub">{players.length} de {server.slots} slots ocupados.</p>
      </div>
      <div className="card">
        <div className="card-header">
          <I2P.IconPlayers size={14} style={{color:'var(--red)'}}/>
          <div className="card-title">Conectados ahora</div>
          <span className="badge badge-green right">{players.length} en línea</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{width: 40}}>#</th>
              <th>Nombre</th>
              <th>Coche</th>
              <th style={{width: 80}}>Vueltas</th>
              <th style={{width: 110}}>Mejor</th>
              <th style={{width: 110}}>Última</th>
              <th style={{width: 70}}>Ping</th>
              {isAdmin && <th style={{width: 140}}></th>}
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => (
              <tr key={p.id}>
                <td><div className={`player-pos ${i === 0 ? 'p1' : ''}`}>{i + 1}</div></td>
                <td>
                  <div className="row" style={{gap:5, alignItems:'center'}}>
                    <span className="player-name">{p.name}</span>
                    {p.nation && (() => { const f = (window.AppUtils || {}).nationFlag?.(p.nation); return f ? <img src={f} alt={p.nation} title={p.nation} style={{height:9,width:'auto',borderRadius:1,opacity:0.75}} onError={e=>{e.target.style.display='none'}}/> : null; })()}
                  </div>
                  <div className="row" style={{gap: 4, alignItems:'center', marginTop:2}}>
                    <div className="mono" style={{fontSize: 10.5, color: 'var(--text-faint)'}}>{p.steam}</div>
                    {p.steam && (
                      <a href={`https://steamcommunity.com/profiles/${p.steam}`} target="_blank" rel="noreferrer"
                        style={{display:'flex', color:'var(--text-faint)', opacity:0.7, lineHeight:1}}
                        title="Ver perfil de Steam">
                        <I2P.IconSteam size={11}/>
                      </a>
                    )}
                  </div>
                </td>
                <td className="muted">{p.car}</td>
                <td>{p.laps}</td>
                <td className="mono">{p.bestMs != null ? fmtMs(p.bestMs) : (p.best || '—')}</td>
                <td className="mono muted">{p.lastMs != null ? fmtMs(p.lastMs) : (p.last || '—')}</td>
                <td>
                  <span className={`badge ${p.ping > 70 ? 'badge-amber' : 'badge-green'}`}>
                    {p.ping}ms
                  </span>
                </td>
                {isAdmin && (
                  <td>
                    <div className="row" style={{gap: 4}}>
                      <button className="btn btn-sm" onClick={() => onKick(p)}>
                        <I2P.IconKick size={12}/> Kick
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => onBan(p)}>
                        Ban
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {renderPast}
    </>
  );
}

// Logs page
function PageLogs({ server }) {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('all');
  const [logs, setLogs] = useState([]);
  const ref = useRef(null);

  useEffect(() => {
    const load = () => {
      fetch('/api/logs?n=150')
        .then(r => r.json())
        .then(d => setLogs(d.lines || []))
        .catch(() => {});
    };
    load();
    if (paused) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [paused]);

  useEffect(() => {
    if (ref.current && !paused) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [logs, paused]);

  const filtered = filter === 'all' ? logs : logs.filter(l => l.lvl === filter);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Logs en vivo</h1>
        <p className="page-sub">Salida de la consola del servidor con filtrado por nivel.</p>
      </div>
      <div className="toolbar">
        <div className="segmented">
          {['all', 'info', 'ok', 'warn', 'error'].map(f => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Todo' : f.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="right row" style={{gap: 6}}>
          <button className="btn btn-sm" onClick={() => setPaused(p => !p)}>
            {paused ? <><I2.IconPlay size={11}/> Reanudar</> : <><I2.IconStop size={11}/> Pausar</>}
          </button>
          <button className="btn btn-sm" onClick={() => setLogs([])}>
            <I2.IconTrash size={11}/> Limpiar
          </button>
          <button className="btn btn-sm" onClick={() => {
            const text = filtered.map(l => `[${l.time}] [${l.lvl.toUpperCase()}] [${l.tag}] ${l.msg}`).join('\n');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = `ac-logs-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
            a.click();
          }}>
            <I2.IconDownload size={11}/> Exportar
          </button>
        </div>
      </div>

      <div className="logs" ref={ref}>
        {filtered.length === 0 && <div style={{color:'#71717a'}}>Sin entradas.</div>}
        {filtered.map(l => (
          <div className="logs-line" key={l.id}>
            <span className="logs-time">{l.time}</span>
            <span className={`logs-level ${l.lvl}`}>{l.lvl.toUpperCase()}</span>
            <span className="logs-tag">[{l.tag}]</span>
            <span className="logs-msg">{l.msg}</span>
          </div>
        ))}
      </div>
    </>
  );
}

window.AppPagesA = { PageDashboard, PagePlayers, PageLogs };
