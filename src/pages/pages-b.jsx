// Pages: Cars, Tracks, Session
const { useState: useStateB, useMemo: useMemoB } = React;
const I3 = window.AppIcons;

function PageCars({ cars, sessionCfg, setSessionCfg, mode = 'browse' }) {
  const [query, setQuery] = useStateB('');
  const [cls, setCls] = useStateB('all');

  const classes = useMemoB(() => ['all', ...Array.from(new Set(cars.map(c => c.cls)))], [cars]);

  const filtered = useMemoB(() => cars.filter(c => {
    if (cls !== 'all' && c.cls !== cls) return false;
    if (query && !(`${c.brand} ${c.name}`.toLowerCase().includes(query.toLowerCase()))) return false;
    return true;
  }), [cars, cls, query]);

  const toggle = (id) => {
    setSessionCfg(cfg => {
      const has = cfg.carIds.includes(id);
      return { ...cfg, carIds: has ? cfg.carIds.filter(x => x !== id) : [...cfg.carIds, id] };
    });
  };

  const selectedCount = sessionCfg.carIds.length;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Coches</h1>
        <p className="page-sub">{cars.length} coches detectados en <span className="mono">/content/cars</span>. {selectedCount > 0 && <>· <strong style={{color:'var(--red)'}}>{selectedCount} seleccionado{selectedCount === 1 ? '' : 's'}</strong> para la próxima sesión.</>}</p>
      </div>

      <div className="toolbar">
        <div className="search">
          <I3.IconSearch size={14} className="search-icon"/>
          <input className="input" placeholder="Buscar por marca o modelo…" value={query} onChange={e=>setQuery(e.target.value)}/>
        </div>
        <div className="tag-row">
          {classes.map(c => (
            <button key={c} className={`tag ${cls === c ? 'active' : ''}`} onClick={()=>setCls(c)}>
              {c === 'all' ? 'Todos' : c}
            </button>
          ))}
        </div>
        <div className="right row" style={{gap: 6}}>
          {selectedCount > 0 && (
            <button className="btn btn-sm" onClick={()=>setSessionCfg(c => ({...c, carIds: []}))}>
              <I3.IconX size={11}/> Limpiar selección
            </button>
          )}
          <button className="btn btn-sm" onClick={()=>setSessionCfg(c => ({...c, carIds: filtered.map(x => x.id)}))}>
            Seleccionar visibles
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card"><div className="empty">No se encontraron coches con esos filtros.</div></div>
      ) : (
        <div className="car-grid">
          {filtered.map(c => {
            const selected = sessionCfg.carIds.includes(c.id);
            return (
              <div key={c.id} className={`car-card ${selected ? 'selected' : ''}`} onClick={() => toggle(c.id)}>
                <div className="car-thumb">
                  <img src={c.thumb} alt={c.name} style={{width:'100%', height:'100%', objectFit:'cover'}}
                    onError={e => { e.target.style.display='none'; }}/>
                </div>
                <div className="car-check">
                  {selected && <I3.IconCheck size={12}/>}
                </div>
                <div className="car-meta">
                  <div className="car-name">{c.name}</div>
                  <div className="car-brand">{c.brand} · {c.year}</div>
                  <div className="car-stats">
                    <span className="car-stat">{c.power} CV</span>
                    <span className="car-stat">{c.weight} kg</span>
                    <span className="badge" style={{padding:'1px 6px', fontSize: 10}}>{c.cls}</span>
                  </div>
                  <div className="mono" style={{fontSize: 10, color: 'var(--text-faint)', marginTop: 6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                    {c.id}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function PageTracks({ tracks, sessionCfg, setSessionCfg }) {
  const [query, setQuery] = useStateB('');
  const filtered = tracks.filter(t => !query || (t.name + ' ' + t.loc).toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Tramos</h1>
        <p className="page-sub">{tracks.length} circuitos en <span className="mono">/content/tracks</span>. Selecciona uno para la próxima sesión.</p>
      </div>

      <div className="toolbar">
        <div className="search">
          <I3.IconSearch size={14} className="search-icon"/>
          <input className="input" placeholder="Buscar circuito…" value={query} onChange={e=>setQuery(e.target.value)}/>
        </div>
      </div>

      <div className="track-grid">
        {filtered.map(t => {
          const selected = sessionCfg.trackId === t.id;
          return (
            <div key={t.id} className={`track-card ${selected ? 'selected' : ''}`}
              onClick={() => setSessionCfg(c => ({...c, trackId: t.id, layout: t.layouts[0]}))}>
              <div className="track-thumb">
                <img src={t.thumb} alt={t.name} style={{width:'100%', height:'100%', objectFit:'cover'}}
                  onError={e => { e.target.style.display='none'; }}/>
              </div>
              <div className="track-meta">
                <div className="row-between">
                  <div>
                    <div className="track-name">{t.name}</div>
                    <div className="track-loc">{t.loc}</div>
                  </div>
                  {selected && <span className="badge badge-red"><I3.IconCheck size={10}/> Seleccionado</span>}
                </div>
                <div className="track-info">
                  <span>{t.length} km</span>
                  <span>·</span>
                  <span>{t.layouts.length} layout{t.layouts.length === 1 ? '' : 's'}</span>
                  <span>·</span>
                  <span>{t.pits} pits</span>
                </div>
                <div className="mono" style={{fontSize: 10.5, color: 'var(--text-faint)', marginTop: 8}}>{t.id}</div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function PageSession({ tracks, cars, sessionCfg, setSessionCfg, isAdmin, onApply }) {
  const track = tracks.find(t => t.id === sessionCfg.trackId);
  const selectedCars = cars.filter(c => sessionCfg.carIds.includes(c.id));
  const set = (k, v) => setSessionCfg(c => ({...c, [k]: v}));

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Configurador de sesión</h1>
        <p className="page-sub">Define los parámetros para la próxima sesión multijugador.</p>
      </div>

      <div className="grid-2" style={{gridTemplateColumns: '1.4fr 1fr', alignItems: 'start'}}>
        <div className="col" style={{gap: 16}}>
          <div className="card">
            <div className="card-header">
              <I3.IconFlag size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">Modo y duración</div>
            </div>
            <div className="card-body col" style={{gap: 16}}>
              <div className="field">
                <label className="field-label">Modo de sesión</label>
                <div className="segmented" style={{alignSelf: 'flex-start'}}>
                  {['Práctica', 'Quali', 'Carrera'].map(m => (
                    <button key={m} className={sessionCfg.mode === m ? 'active' : ''} onClick={()=>set('mode', m)}>{m}</button>
                  ))}
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">{sessionCfg.mode === 'Carrera' ? 'Vueltas' : 'Duración (min)'}</label>
                  <input className="input" type="number" min="1" value={sessionCfg.laps} onChange={e=>set('laps', Number(e.target.value))} disabled={!isAdmin}/>
                </div>
                <div className="field">
                  <label className="field-label">Slots máximos</label>
                  <input className="input" type="number" min="2" max="64" value={sessionCfg.slots} onChange={e=>set('slots', Number(e.target.value))} disabled={!isAdmin}/>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <I3.IconCloud size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">Condiciones</div>
            </div>
            <div className="card-body col" style={{gap: 16}}>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">Hora del día</label>
                  <div className="row" style={{gap: 10}}>
                    <input type="range" min="0" max="23" value={sessionCfg.time} onChange={e=>set('time', Number(e.target.value))} style={{flex: 1, accentColor: 'var(--red)'}} disabled={!isAdmin}/>
                    <div className="mono" style={{minWidth: 44, textAlign:'right'}}>{String(sessionCfg.time).padStart(2,'0')}:00</div>
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">Clima</label>
                  <select className="select" value={sessionCfg.weather} onChange={e=>set('weather', e.target.value)} disabled={!isAdmin}>
                    <option>Soleado</option>
                    <option>Nublado</option>
                    <option>Niebla ligera</option>
                    <option>Lluvia ligera</option>
                    <option>Tormenta</option>
                  </select>
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">Temp. ambiente: {sessionCfg.airTemp}°C</label>
                  <input type="range" min="5" max="40" value={sessionCfg.airTemp} onChange={e=>set('airTemp', Number(e.target.value))} style={{accentColor: 'var(--red)'}} disabled={!isAdmin}/>
                </div>
                <div className="field">
                  <label className="field-label">Daños: {sessionCfg.damage}%</label>
                  <input type="range" min="0" max="100" step="10" value={sessionCfg.damage} onChange={e=>set('damage', Number(e.target.value))} style={{accentColor: 'var(--red)'}} disabled={!isAdmin}/>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <I3.IconShield size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">Asistencias y penalizaciones</div>
            </div>
            <div className="card-body col" style={{gap: 12}}>
              {[
                ['ABS', 'abs'],
                ['Control de tracción', 'tc'],
                ['Cambio automático', 'autoShift'],
                ['Línea ideal', 'ideal'],
                ['Penalizaciones activas', 'penalties'],
                ['Desgaste de neumáticos', 'tireWear'],
                ['Consumo de combustible', 'fuel'],
              ].map(([label, key]) => (
                <div className="row-between" key={key}>
                  <span style={{fontSize: 13}}>{label}</span>
                  <div className={`switch ${sessionCfg[key] ? 'on' : ''}`} onClick={()=>isAdmin && set(key, !sessionCfg[key])}></div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="col" style={{gap: 16, position: 'sticky', top: 76}}>
          <div className="card">
            <div className="card-header">
              <I3.IconTrack size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">Tramo seleccionado</div>
            </div>
            {track ? (
              <>
                <div style={{padding: '0 18px 14px'}}>
                  <div style={{borderRadius: 6, overflow:'hidden', background: 'var(--bg-3)', marginTop: 14}}>
                    <img src={track.thumb} style={{width:'100%', display:'block'}}
                      onError={e => { e.target.style.display='none'; }}/>
                  </div>
                  <div style={{marginTop: 12}}>
                    <div style={{fontSize: 14, fontWeight: 600}}>{track.name}</div>
                    <div className="muted" style={{fontSize: 12}}>{track.loc} · {track.length} km</div>
                  </div>
                  <div className="field" style={{marginTop: 12}}>
                    <label className="field-label">Layout</label>
                    <select className="select" value={sessionCfg.layout} onChange={e=>set('layout', e.target.value)} disabled={!isAdmin}>
                      {track.layouts.map(l => <option key={l}>{l}</option>)}
                    </select>
                  </div>
                </div>
              </>
            ) : <div className="empty">Ningún tramo seleccionado.</div>}
          </div>

          <div className="card">
            <div className="card-header">
              <I3.IconCar size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">Coches permitidos</div>
              <span className="badge right">{selectedCars.length}</span>
            </div>
            <div style={{maxHeight: 220, overflowY: 'auto'}}>
              {selectedCars.length === 0 ? (
                <div className="empty" style={{padding: '28px 20px'}}>
                  Sin coches seleccionados. Ve a <strong>Coches</strong> para elegirlos.
                </div>
              ) : selectedCars.map(c => (
                <div key={c.id} style={{display:'flex', alignItems:'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border)'}}>
                  <div style={{width: 36, height: 22, borderRadius: 3, overflow:'hidden', background: 'var(--bg-3)', flexShrink: 0}}>
                    <img src={c.thumb} style={{width:'100%', height:'100%', objectFit:'cover'}}/>
                  </div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div style={{fontSize: 12.5, fontWeight: 500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{c.name}</div>
                    <div className="muted" style={{fontSize: 11}}>{c.brand}</div>
                  </div>
                  <button className="icon-btn" style={{width: 24, height: 24}} onClick={()=>setSessionCfg(s => ({...s, carIds: s.carIds.filter(x => x !== c.id)}))}>
                    <I3.IconX size={12}/>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {isAdmin && (
            <button className="btn btn-primary" style={{padding: '10px', justifyContent:'center'}} onClick={onApply}>
              <I3.IconCheck size={14}/> Aplicar configuración y reiniciar sesión
            </button>
          )}
        </div>
      </div>
    </>
  );
}

window.AppPagesB = { PageCars, PageTracks, PageSession };
