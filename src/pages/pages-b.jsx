// Pages: Cars, Tracks, Session
const { useState: useStateB, useMemo: useMemoB, useEffect: useEffectB } = React;
const I3 = window.AppIcons;

// ── Car modal ─────────────────────────────────────────────────────────────────
function CarModal({ car, selected, onToggle, onClose }) {
  const [skinIdx, setSkinIdx] = useStateB(0);

  useEffectB(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const hasSkins    = car.skins && car.skins.length > 0;
  const hasMultiple = car.skins && car.skins.length > 1;
  const hasSpecs    = car.specs && Object.values(car.specs).some(Boolean);

  const imgSrc = hasSkins
    ? `/api/content/cars/${encodeURIComponent(car.id)}/skins/${encodeURIComponent(car.skins[skinIdx])}/preview`
    : `/api/content/cars/${encodeURIComponent(car.id)}/thumb`;

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{maxWidth: 740, width: '95vw'}}>

        {/* Header */}
        <div className="modal-header">
          <div style={{flex: 1, minWidth: 0}}>
            <div className="modal-title" style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
              {car.name}
            </div>
            <div style={{fontSize: 12, color: 'var(--text-muted)', marginTop: 2}}>
              {[car.brand, car.year, car.cls].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><I3.IconX size={14}/></button>
        </div>

        {/* Two-column body */}
        <div style={{display: 'grid', gridTemplateColumns: '54% 46%', minHeight: 260}}>

          {/* ── Left: main preview + skin thumbnails ── */}
          <div style={{padding: 18, borderRight: '1px solid var(--border)', display:'flex', flexDirection:'column', gap: 12}}>

            {/* Main preview */}
            <div style={{borderRadius: 6, overflow:'hidden', background:'var(--bg-3)', height: 168, flexShrink: 0}}>
              <img
                src={imgSrc}
                alt={hasSkins ? car.skins[skinIdx] : car.name}
                style={{width:'100%', height:'100%', objectFit:'cover', display:'block'}}
                onError={e => { e.target.style.display='none'; }}
              />
            </div>

            {/* Skin indicator */}
            {hasSkins && (
              <div style={{fontSize: 11, color:'var(--text-muted)'}}>
                Diseño: <strong style={{color:'var(--text)', fontWeight:500}}>{car.skins[skinIdx]}</strong>
                {hasMultiple && <span style={{color:'var(--text-faint)', marginLeft: 6}}>{skinIdx + 1} / {car.skins.length}</span>}
              </div>
            )}

            {/* Skin thumbnail grid */}
            {hasMultiple && (
              <div style={{display:'flex', flexWrap:'wrap', gap: 5, overflowY:'auto', maxHeight: 140}}>
                {car.skins.map((skin, i) => (
                  <button
                    key={skin}
                    title={skin}
                    onClick={() => setSkinIdx(i)}
                    style={{
                      padding: 0,
                      border: `2px solid ${i === skinIdx ? 'var(--red)' : 'var(--border)'}`,
                      borderRadius: 5, overflow:'hidden', cursor:'pointer',
                      background:'var(--bg-3)', width: 72, height: 45, flexShrink: 0,
                      transition: 'border-color 120ms',
                    }}
                  >
                    <img
                      src={`/api/content/cars/${encodeURIComponent(car.id)}/skins/${encodeURIComponent(skin)}/preview`}
                      alt={skin}
                      style={{width:'100%', height:'100%', objectFit:'cover', display:'block'}}
                      onError={e => { e.target.style.display='none'; }}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Right: specs + description ── */}
          <div style={{padding: 18, overflowY:'auto', maxHeight: 400}}>

            {hasSpecs && (
              <div style={{marginBottom: 16}}>
                <div style={{fontSize:10.5, fontWeight:600, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:10}}>
                  Especificaciones
                </div>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 14px'}}>
                  {car.specs.bhp      && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>Potencia</div><div style={{fontSize:13, fontWeight:500}}>{car.specs.bhp}</div></div>}
                  {car.specs.torque   && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>Par motor</div><div style={{fontSize:13, fontWeight:500}}>{car.specs.torque}</div></div>}
                  {car.specs.weight   && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>Peso</div><div style={{fontSize:13, fontWeight:500}}>{car.specs.weight}</div></div>}
                  {car.specs.topspeed && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>Vel. máx.</div><div style={{fontSize:13, fontWeight:500}}>{car.specs.topspeed}</div></div>}
                </div>
              </div>
            )}

            {car.description && (
              <div>
                <div style={{fontSize:10.5, fontWeight:600, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:8}}>
                  Descripción
                </div>
                <div style={{fontSize:11.5, color:'var(--text-muted)', lineHeight:1.65}}>
                  {car.description}
                </div>
              </div>
            )}

            {!hasSpecs && !car.description && (
              <div style={{fontSize:12.5, color:'var(--text-faint)', lineHeight:1.6}}>
                Sin información adicional disponible para este coche.
              </div>
            )}

            <div className="mono" style={{fontSize:10, color:'var(--text-faint)', marginTop:14, wordBreak:'break-all'}}>
              {car.id}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cerrar</button>
          <button
            className="btn btn-primary"
            style={selected ? {background:'transparent', borderColor:'var(--red)', color:'var(--red)'} : {}}
            onClick={onToggle}
          >
            {selected
              ? <><I3.IconX size={12}/> Quitar de sesión</>
              : <><I3.IconCheck size={12}/> Añadir a sesión</>
            }
          </button>
        </div>

      </div>
    </div>
  );
}

// ── Car card (simplified — opens modal on click) ───────────────────────────────
function CarCard({ car, selected, onOpen }) {
  const skinsCount = car.skins?.length || 0;
  const [imgFailed, setImgFailed] = useStateB(false);
  const initial = (car.brand || car.name || '?').slice(0, 2).toUpperCase();

  return (
    <div className={`car-card ${selected ? 'selected' : ''}`} onClick={onOpen}>
      <div className="car-thumb" style={{position:'relative', overflow:'hidden'}}>
        {car.thumb && !imgFailed ? (
          <img
            src={car.thumb}
            alt={car.name}
            style={{width:'100%', height:'100%', objectFit:'cover'}}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div style={{
            width:'100%', height:'100%', display:'flex', alignItems:'center',
            justifyContent:'center', flexDirection:'column', gap: 4,
            background:'var(--bg-3)', color:'var(--text-faint)',
          }}>
            <span style={{fontSize:22, fontWeight:700, letterSpacing:'-0.03em', opacity:0.4}}>{initial}</span>
          </div>
        )}
        {skinsCount > 1 && (
          <span style={{
            position:'absolute', bottom:4, right:4,
            background:'rgba(0,0,0,0.65)', color:'#fff',
            fontSize:9.5, borderRadius:3, padding:'2px 5px',
          }}>
            {skinsCount} skins
          </span>
        )}
      </div>

      <div className="car-check">{selected && <I3.IconCheck size={12}/>}</div>

      <div className="car-meta">
        <div className="car-name">{car.name}</div>
        <div className="car-brand">{[car.brand, car.year].filter(Boolean).join(' · ')}</div>
        <div className="car-stats">
          {car.specs?.bhp    && <span className="car-stat">{car.specs.bhp}</span>}
          {car.specs?.weight && <span className="car-stat">{car.specs.weight}</span>}
          {car.cls && <span className="badge" style={{padding:'1px 6px', fontSize:10}}>{car.cls}</span>}
        </div>
        <div className="mono" style={{fontSize:10, color:'var(--text-faint)', marginTop:6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {car.id}
        </div>
      </div>
    </div>
  );
}

// ── Track modal (multi-layout tracks) ─────────────────────────────────────────
function TrackModal({ track, sessionCfg, setSessionCfg, onClose }) {
  const isSelected    = sessionCfg.trackId === track.id;
  const hasLayouts    = track.layouts.length > 1;
  const [activeLayout, setActiveLayout] = useStateB(
    isSelected ? (sessionCfg.layout || track.layouts[0] || '') : (track.layouts[0] || '')
  );

  useEffectB(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const ld      = track.layoutDetails?.[activeLayout];
  const name    = ld?.name        || track.name;
  const desc    = ld?.description || track.description || '';
  const length  = ld?.length      ?? track.length;
  const pits    = ld?.pits        ?? track.pits;
  const thumbSrc = ld?.thumb || track.thumb;

  const selectAndClose = () => {
    setSessionCfg(c => ({ ...c, trackId: track.id, layout: activeLayout }));
    onClose();
  };

  const isActiveSelected = isSelected && sessionCfg.layout === activeLayout;

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{maxWidth: 720, width: '95vw'}}>

        <div className="modal-header">
          <div style={{flex:1, minWidth:0}}>
            <div className="modal-title" style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
              {name}
            </div>
            <div style={{fontSize:12, color:'var(--text-muted)', marginTop:2}}>
              {[track.city, length > 0 ? `${length} km` : null, pits ? `${pits} pits` : null].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><I3.IconX size={14}/></button>
        </div>

        <div style={{display:'grid', gridTemplateColumns:'54% 46%', minHeight:240}}>

          {/* Left: track preview + layout thumbnails */}
          <div style={{padding:18, borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:12}}>
            <div style={{borderRadius:6, overflow:'hidden', background:'var(--bg-3)', height:160, flexShrink:0}}>
              <img
                key={thumbSrc}
                src={thumbSrc}
                alt={name}
                style={{width:'100%', height:'100%', objectFit:'cover', display:'block'}}
                onError={e => { e.target.style.display='none'; }}
              />
            </div>

            {hasLayouts && (
              <>
                <div style={{fontSize:11, color:'var(--text-muted)'}}>
                  Layout: <strong style={{color:'var(--text)', fontWeight:500}}>{activeLayout || 'Default'}</strong>
                  <span style={{color:'var(--text-faint)', marginLeft:6}}>
                    {track.layouts.indexOf(activeLayout) + 1} / {track.layouts.length}
                  </span>
                </div>
                <div style={{display:'flex', flexWrap:'wrap', gap:5, overflowY:'auto', maxHeight:120}}>
                  {track.layouts.map(l => {
                    const ltd  = track.layoutDetails?.[l];
                    const lThumb = ltd?.thumb || track.thumb;
                    return (
                      <button
                        key={l}
                        title={l || 'Default'}
                        onClick={() => setActiveLayout(l)}
                        style={{
                          padding:0,
                          border:`2px solid ${l === activeLayout ? 'var(--red)' : 'var(--border)'}`,
                          borderRadius:5, overflow:'hidden', cursor:'pointer',
                          background:'var(--bg-3)', width:72, height:45, flexShrink:0,
                          transition:'border-color 120ms',
                        }}
                      >
                        <img
                          src={lThumb}
                          alt={l}
                          style={{width:'100%', height:'100%', objectFit:'cover', display:'block'}}
                          onError={e => { e.target.style.display='none'; }}
                        />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Right: description + stats */}
          <div style={{padding:18, overflowY:'auto', maxHeight:400}}>
            {(length > 0 || pits > 0) && (
              <div style={{marginBottom:16}}>
                <div style={{fontSize:10.5, fontWeight:600, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:10}}>
                  Datos del circuito
                </div>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 14px'}}>
                  {length > 0 && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>Longitud</div><div style={{fontSize:13, fontWeight:500}}>{length} km</div></div>}
                  {pits > 0   && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>Pit boxes</div><div style={{fontSize:13, fontWeight:500}}>{pits}</div></div>}
                </div>
              </div>
            )}
            {desc && (
              <div>
                <div style={{fontSize:10.5, fontWeight:600, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:8}}>
                  Descripción
                </div>
                <div style={{fontSize:11.5, color:'var(--text-muted)', lineHeight:1.65}}>{desc}</div>
              </div>
            )}
            {!desc && length === 0 && (
              <div style={{fontSize:12.5, color:'var(--text-faint)', lineHeight:1.6}}>
                Sin información adicional disponible para este circuito.
              </div>
            )}
            <div className="mono" style={{fontSize:10, color:'var(--text-faint)', marginTop:14, wordBreak:'break-all'}}>
              {track.id}{activeLayout ? ` / ${activeLayout}` : ''}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cerrar</button>
          <button
            className="btn btn-primary"
            style={isActiveSelected ? {background:'transparent', borderColor:'var(--red)', color:'var(--red)'} : {}}
            onClick={selectAndClose}
          >
            {isActiveSelected
              ? <><I3.IconCheck size={12}/> Seleccionado</>
              : <><I3.IconCheck size={12}/> Seleccionar layout</>
            }
          </button>
        </div>

      </div>
    </div>
  );
}

// ── Track card ────────────────────────────────────────────────────────────────
function TrackCard({ track, sessionCfg, setSessionCfg, onOpenModal }) {
  const selected      = sessionCfg.trackId === track.id;
  const currentLayout = selected ? sessionCfg.layout : null;
  const hasLayouts    = track.layouts.length > 1;
  const descFull      = track.description || '';

  const handleClick = () => {
    if (hasLayouts) {
      onOpenModal(track);
    } else {
      setSessionCfg(c => ({
        ...c, trackId: track.id,
        layout: c.trackId === track.id ? c.layout : (track.layouts[0] || ''),
      }));
    }
  };

  return (
    <div className={`track-card ${selected ? 'selected' : ''}`} onClick={handleClick}>
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
          <div style={{display:'flex', gap:4, alignItems:'center', flexShrink:0}}>
            {hasLayouts && <span className="badge" style={{fontSize:10}}>{track.layouts.length} layouts</span>}
            {selected && <span className="badge badge-red"><I3.IconCheck size={10}/> Sel.</span>}
          </div>
        </div>

        <div className="track-info">
          {track.length > 0 && <><span>{track.length} km</span><span>·</span></>}
          <span>{track.pits} pits</span>
          {selected && currentLayout && <><span>·</span><span className="mono" style={{fontSize:10}}>{currentLayout}</span></>}
        </div>

        {descFull && !hasLayouts && (
          <div style={{marginTop:6, fontSize:11, color:'var(--text-muted)', lineHeight:1.5, display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden'}}>
            {descFull}
          </div>
        )}
        {hasLayouts && (
          <div style={{marginTop:6, fontSize:10.5, color:'var(--text-faint)'}}>
            Clic para ver los {track.layouts.length} layouts
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
  const [modalCar,  setModalCar]  = useStateB(null);

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
      <div className="toolbar" style={{paddingTop: 0, gap: 8, flexWrap:'wrap'}}>
        <div className="tag-row">
          <span style={{fontSize:11, color:'var(--text-faint)', marginRight:2}}>Categoría:</span>
          {classes.map(c => (
            <button key={c} className={`tag ${cls === c ? 'active' : ''}`} onClick={() => setCls(c)}>
              {c === 'all' ? 'Todas' : c}
            </button>
          ))}
        </div>
        {kunosCount > 0 && (
          <div className="tag-row" style={{marginLeft: 'auto'}}>
            <span style={{fontSize:11, color:'var(--text-faint)', marginRight:2}}>Kunos:</span>
            <button className={`tag ${showKunos ? 'active' : ''}`} onClick={() => setShowKunos(true)}>
              Mostrar ({kunosCount})
            </button>
            <button className={`tag ${!showKunos ? 'active' : ''}`} onClick={() => setShowKunos(false)}>
              Ocultar
            </button>
          </div>
        )}
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
              onOpen={() => setModalCar(c)}
            />
          ))}
        </div>
      )}

      {modalCar && (
        <CarModal
          car={modalCar}
          selected={sessionCfg.carIds.includes(modalCar.id)}
          onToggle={() => toggle(modalCar.id)}
          onClose={() => setModalCar(null)}
        />
      )}
    </>
  );
}

// ── PageTracks ────────────────────────────────────────────────────────────────
function PageTracks({ tracks, sessionCfg, setSessionCfg }) {
  const [query,      setQuery]      = useStateB('');
  const [showKunos,  setShowKunos]  = useStateB(true);
  const [modalTrack, setModalTrack] = useStateB(null);

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
      </div>
      {kunosCount > 0 && (
        <div className="toolbar" style={{paddingTop:0, gap:8}}>
          <div className="tag-row">
            <span style={{fontSize:11, color:'var(--text-faint)', marginRight:2}}>Kunos:</span>
            <button className={`tag ${showKunos ? 'active' : ''}`} onClick={() => setShowKunos(true)}>
              Mostrar ({kunosCount})
            </button>
            <button className={`tag ${!showKunos ? 'active' : ''}`} onClick={() => setShowKunos(false)}>
              Ocultar
            </button>
          </div>
        </div>
      )}

      <div className="track-grid">
        {filtered.map(t => (
          <TrackCard key={t.id} track={t} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} onOpenModal={setModalTrack}/>
        ))}
      </div>

      {modalTrack && (
        <TrackModal
          track={modalTrack}
          sessionCfg={sessionCfg}
          setSessionCfg={setSessionCfg}
          onClose={() => setModalTrack(null)}
        />
      )}
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
                    <option>Soleado</option><option>Nublado</option>
                    <option>Niebla ligera</option><option>Lluvia ligera</option>
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
                  <button className="icon-btn" style={{width: 24, height: 24}}
                    onClick={() => setSessionCfg(s => ({...s, carIds: s.carIds.filter(x => x !== c.id)}))}>
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
