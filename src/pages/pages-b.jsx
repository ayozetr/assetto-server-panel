// Pages: Cars, Tracks, Session
const { useState: useStateB, useMemo: useMemoB } = React;
const I3 = window.AppIcons;

// ── Car card with skin browsing ───────────────────────────────────────────────
function CarCard({ car, selected, onToggle }) {
  const [skinIdx, setSkinIdx] = useStateB(0);
  const [showDesc, setShowDesc] = useStateB(false);

  const hasSkins   = car.skins && car.skins.length > 0;
  const hasMultiple = car.skins && car.skins.length > 1;

  const imgSrc = hasSkins
    ? `/api/content/cars/${encodeURIComponent(car.id)}/skins/${encodeURIComponent(car.skins[skinIdx])}/preview`
    : `/api/content/cars/${encodeURIComponent(car.id)}/thumb`;

  const prevSkin = (e) => {
    e.stopPropagation();
    setSkinIdx(i => (i - 1 + car.skins.length) % car.skins.length);
  };
  const nextSkin = (e) => {
    e.stopPropagation();
    setSkinIdx(i => (i + 1) % car.skins.length);
  };

  const arrowStyle = {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)',
    background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none',
    borderRadius: 4, width: 22, height: 30, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 18, lineHeight: 1, padding: 0, zIndex: 2,
  };

  const descFull  = car.description || '';
  const descShort = descFull.slice(0, 120);

  return (
    <div className={`car-card ${selected ? 'selected' : ''}`} onClick={onToggle}>

      {/* Thumbnail with skin navigation */}
      <div className="car-thumb" style={{position: 'relative', overflow: 'hidden'}}>
        <img src={imgSrc} alt={car.name}
          style={{width:'100%', height:'100%', objectFit:'cover'}}
          onError={e => { e.target.style.display='none'; }}
        />
        {hasMultiple && <>
          <button style={{...arrowStyle, left: 4}} onClick={prevSkin}>‹</button>
          <button style={{...arrowStyle, right: 4}} onClick={nextSkin}>›</button>
          <span style={{
            position:'absolute', bottom:4, left:'50%', transform:'translateX(-50%)',
            background:'rgba(0,0,0,0.6)', color:'#fff', fontSize:9.5,
            borderRadius:3, padding:'2px 6px', whiteSpace:'nowrap', maxWidth:'90%',
            overflow:'hidden', textOverflow:'ellipsis',
          }}>
            {car.skins[skinIdx]} · {skinIdx + 1}/{car.skins.length}
          </span>
        </>}
      </div>

      <div className="car-check">{selected && <I3.IconCheck size={12}/>}</div>

      <div className="car-meta">
        <div className="car-name">{car.name}</div>
        <div className="car-brand">
          {[car.brand, car.year].filter(Boolean).join(' · ')}
        </div>
        <div className="car-stats">
          {car.specs?.bhp    && <span className="car-stat">{car.specs.bhp}</span>}
          {car.specs?.weight && <span className="car-stat">{car.specs.weight}</span>}
          {car.cls && <span className="badge" style={{padding:'1px 6px', fontSize:10}}>{car.cls}</span>}
        </div>

        {descFull && (
          <div style={{marginTop: 5}}>
            <div style={{fontSize:10.5, color:'var(--text-muted)', lineHeight:1.5}}>
              {showDesc ? descFull : descShort + (descFull.length > 120 ? '…' : '')}
            </div>
            {descFull.length > 120 && (
              <span
                style={{fontSize:10, color:'var(--red)', cursor:'pointer', userSelect:'none'}}
                onClick={e => { e.stopPropagation(); setShowDesc(s => !s); }}
              >
                {showDesc ? 'ver menos' : 'ver más'}
              </span>
            )}
          </div>
        )}

        <div className="mono" style={{fontSize:10, color:'var(--text-faint)', marginTop:6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {car.id}
        </div>
      </div>
    </div>
  );
}

// ── Track card with layout chips ──────────────────────────────────────────────
function TrackCard({ track, sessionCfg, setSessionCfg }) {
  const [showDesc, setShowDesc] = useStateB(false);

  const selected      = sessionCfg.trackId === track.id;
  const currentLayout = selected ? sessionCfg.layout : null;

  const selectLayout = (e, layout) => {
    e.stopPropagation();
    setSessionCfg(c => ({ ...c, trackId: track.id, layout }));
  };

  const descFull  = track.description || '';
  const descShort = descFull.slice(0, 160);

  return (
    <div
      className={`track-card ${selected ? 'selected' : ''}`}
      onClick={() => setSessionCfg(c => ({
        ...c, trackId: track.id,
        layout: c.trackId === track.id ? c.layout : (track.layouts[0] || ''),
      }))}
    >
      <div className="track-thumb">
        <img src={track.thumb} alt={track.name}
          style={{width:'100%', height:'100%', objectFit:'cover'}}
          onError={e => { e.target.style.display='none'; }}
        />
      </div>
      <div className="track-meta">
        <div className="row-between">
          <div>
            <div className="track-name">{track.name}</div>
            <div className="track-loc">{track.city}</div>
          </div>
          {selected && <span className="badge badge-red"><I3.IconCheck size={10}/> Seleccionado</span>}
        </div>

        <div className="track-info">
          {track.length > 0 && <><span>{track.length} km</span><span>·</span></>}
          <span>{track.pits} pits</span>
          {track.layouts.length > 1 && <><span>·</span><span>{track.layouts.length} layouts</span></>}
        </div>

        {/* Layout selector chips */}
        {track.layouts.length > 1 && (
          <div style={{display:'flex', flexWrap:'wrap', gap:4, marginTop:8}}>
            {track.layouts.map(l => (
              <button
                key={l}
                className={`tag ${selected && currentLayout === l ? 'active' : ''}`}
                style={{fontSize:10.5, padding:'2px 8px'}}
                onClick={e => selectLayout(e, l)}
              >
                {l || 'Default'}
              </button>
            ))}
          </div>
        )}

        {/* Description */}
        {descFull && (
          <div style={{marginTop: 7}}>
            <div style={{fontSize:11, color:'var(--text-muted)', lineHeight:1.5}}>
              {showDesc ? descFull : descShort + (descFull.length > 160 ? '…' : '')}
            </div>
            {descFull.length > 160 && (
              <span
                style={{fontSize:10.5, color:'var(--red)', cursor:'pointer', userSelect:'none'}}
                onClick={e => { e.stopPropagation(); setShowDesc(s => !s); }}
              >
                {showDesc ? 'ver menos' : 'ver más'}
              </span>
            )}
          </div>
        )}

        <div className="mono" style={{fontSize:10.5, color:'var(--text-faint)', marginTop:8}}>{track.id}</div>
      </div>
    </div>
  );
}

// ── PageCars ──────────────────────────────────────────────────────────────────
function PageCars({ cars, sessionCfg, setSessionCfg }) {
  const [query,     setQuery]     = useStateB('');
  const [cls,       setCls]       = useStateB('all');
  const [showKunos, setShowKunos] = useStateB(true);

  const kunosCount = useMemoB(() => cars.filter(c => c.id.startsWith('ks_')).length, [cars]);
  const classes    = useMemoB(() => ['all', ...Array.from(new Set(cars.map(c => c.cls).filter(Boolean))).sort()], [cars]);

  const filtered = useMemoB(() => cars.filter(c => {
    if (!showKunos && c.id.startsWith('ks_')) return false;
    if (cls !== 'all' && c.cls !== cls) return false;
    if (query && !(`${c.brand} ${c.name} ${c.id}`).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [cars, cls, query, showKunos]);

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
        <p className="page-sub">
          {cars.length} coches en <span className="mono">/content/cars</span>.
          {selectedCount > 0 && <> · <strong style={{color:'var(--red)'}}>{selectedCount} seleccionado{selectedCount === 1 ? '' : 's'}</strong> para la próxima sesión.</>}
        </p>
      </div>

      <div className="toolbar">
        <div className="search">
          <I3.IconSearch size={14} className="search-icon"/>
          <input className="input" placeholder="Buscar por marca, modelo o ID…" value={query} onChange={e => setQuery(e.target.value)}/>
        </div>
        <div className="tag-row">
          {classes.map(c => (
            <button key={c} className={`tag ${cls === c ? 'active' : ''}`} onClick={() => setCls(c)}>
              {c === 'all' ? 'Todos' : c}
            </button>
          ))}
          {kunosCount > 0 && (
            <button
              className={`tag ${!showKunos ? 'active' : ''}`}
              style={{marginLeft: 8, borderStyle: 'dashed'}}
              onClick={() => setShowKunos(s => !s)}
            >
              {showKunos ? `Ocultar Kunos (${kunosCount})` : `Mostrar Kunos (${kunosCount})`}
            </button>
          )}
        </div>
        <div className="right row" style={{gap: 6}}>
          {selectedCount > 0 && (
            <button className="btn btn-sm" onClick={() => setSessionCfg(c => ({...c, carIds: []}))}>
              <I3.IconX size={11}/> Limpiar selección
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setSessionCfg(c => ({...c, carIds: filtered.map(x => x.id)}))}>
            Seleccionar visibles
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card"><div className="empty">No se encontraron coches con esos filtros.</div></div>
      ) : (
        <div className="car-grid">
          {filtered.map(c => (
            <CarCard
              key={c.id}
              car={c}
              selected={sessionCfg.carIds.includes(c.id)}
              onToggle={() => toggle(c.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ── PageTracks ────────────────────────────────────────────────────────────────
function PageTracks({ tracks, sessionCfg, setSessionCfg }) {
  const [query,     setQuery]     = useStateB('');
  const [showKunos, setShowKunos] = useStateB(true);

  const kunosCount = useMemoB(() => tracks.filter(t => t.id.startsWith('ks_')).length, [tracks]);

  const filtered = useMemoB(() => tracks.filter(t => {
    if (!showKunos && t.id.startsWith('ks_')) return false;
    if (query && !(t.name + ' ' + t.city + ' ' + t.id).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [tracks, query, showKunos]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Tramos</h1>
        <p className="page-sub">{tracks.length} circuitos en <span className="mono">/content/tracks</span>. Selecciona uno para la próxima sesión.</p>
      </div>

      <div className="toolbar">
        <div className="search">
          <I3.IconSearch size={14} className="search-icon"/>
          <input className="input" placeholder="Buscar circuito…" value={query} onChange={e => setQuery(e.target.value)}/>
        </div>
        {kunosCount > 0 && (
          <button
            className={`tag ${!showKunos ? 'active' : ''}`}
            style={{borderStyle: 'dashed'}}
            onClick={() => setShowKunos(s => !s)}
          >
            {showKunos ? `Ocultar Kunos (${kunosCount})` : `Mostrar Kunos (${kunosCount})`}
          </button>
        )}
      </div>

      <div className="track-grid">
        {filtered.map(t => (
          <TrackCard key={t.id} track={t} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg}/>
        ))}
      </div>
    </>
  );
}

// ── PageSession ───────────────────────────────────────────────────────────────
function PageSession({ tracks, cars, sessionCfg, setSessionCfg, isAdmin, onApply }) {
  const track        = tracks.find(t => t.id === sessionCfg.trackId);
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
                    <button key={m} className={sessionCfg.mode === m ? 'active' : ''} onClick={() => set('mode', m)}>{m}</button>
                  ))}
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">{sessionCfg.mode === 'Carrera' ? 'Vueltas' : 'Duración (min)'}</label>
                  <input className="input" type="number" min="1" value={sessionCfg.laps} onChange={e => set('laps', Number(e.target.value))} disabled={!isAdmin}/>
                </div>
                <div className="field">
                  <label className="field-label">Slots máximos</label>
                  <input className="input" type="number" min="2" max="64" value={sessionCfg.slots} onChange={e => set('slots', Number(e.target.value))} disabled={!isAdmin}/>
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
                    <input type="range" min="0" max="23" value={sessionCfg.time} onChange={e => set('time', Number(e.target.value))} style={{flex: 1, accentColor: 'var(--red)'}} disabled={!isAdmin}/>
                    <div className="mono" style={{minWidth: 44, textAlign:'right'}}>{String(sessionCfg.time).padStart(2,'0')}:00</div>
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">Clima</label>
                  <select className="select" value={sessionCfg.weather} onChange={e => set('weather', e.target.value)} disabled={!isAdmin}>
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
                  <input type="range" min="5" max="40" value={sessionCfg.airTemp} onChange={e => set('airTemp', Number(e.target.value))} style={{accentColor: 'var(--red)'}} disabled={!isAdmin}/>
                </div>
                <div className="field">
                  <label className="field-label">Daños: {sessionCfg.damage}%</label>
                  <input type="range" min="0" max="100" step="10" value={sessionCfg.damage} onChange={e => set('damage', Number(e.target.value))} style={{accentColor: 'var(--red)'}} disabled={!isAdmin}/>
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
                ['ABS', 'abs'], ['Control de tracción', 'tc'], ['Cambio automático', 'autoShift'],
                ['Línea ideal', 'ideal'], ['Penalizaciones activas', 'penalties'],
                ['Desgaste de neumáticos', 'tireWear'], ['Consumo de combustible', 'fuel'],
              ].map(([label, key]) => (
                <div className="row-between" key={key}>
                  <span style={{fontSize: 13}}>{label}</span>
                  <div className={`switch ${sessionCfg[key] ? 'on' : ''}`} onClick={() => isAdmin && set(key, !sessionCfg[key])}></div>
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
              <div style={{padding: '0 18px 14px'}}>
                <div style={{borderRadius: 6, overflow:'hidden', background: 'var(--bg-3)', marginTop: 14}}>
                  <img src={track.thumb} style={{width:'100%', display:'block'}}
                    onError={e => { e.target.style.display='none'; }}/>
                </div>
                <div style={{marginTop: 12}}>
                  <div style={{fontSize: 14, fontWeight: 600}}>{track.name}</div>
                  <div className="muted" style={{fontSize: 12}}>{track.city} · {track.length} km</div>
                </div>
                <div className="field" style={{marginTop: 12}}>
                  <label className="field-label">Layout</label>
                  <select className="select" value={sessionCfg.layout} onChange={e => set('layout', e.target.value)} disabled={!isAdmin}>
                    {track.layouts.map(l => <option key={l} value={l}>{l || 'Default'}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div className="empty">Ningún tramo seleccionado.</div>
            )}
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
                    <img src={c.thumb} style={{width:'100%', height:'100%', objectFit:'cover'}}
                      onError={e => { e.target.style.display='none'; }}/>
                  </div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div style={{fontSize: 12.5, fontWeight: 500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{c.name}</div>
                    <div className="muted" style={{fontSize: 11}}>{c.brand}</div>
                  </div>
                  <button className="icon-btn" style={{width: 24, height: 24}} onClick={() => setSessionCfg(s => ({...s, carIds: s.carIds.filter(x => x !== c.id)}))}>
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
