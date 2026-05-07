// Pages: Cars, Tracks, Session
const { useState: useStateB, useMemo: useMemoB, useEffect: useEffectB, useRef: useRefB } = React;
const I3 = window.AppIcons;

// ── Car modal ─────────────────────────────────────────────────────────────────
function CarModal({ car, count, onAdd, onRemove, onClose, t }) {
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
          {car.brandLogo && (
            <img src={car.brandLogo} alt={car.brand}
              style={{height:28, width:'auto', objectFit:'contain', marginRight:4, flexShrink:0}}
              onError={e => { e.target.style.display='none'; }}/>
          )}
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
                {t('cars.modal.skin')}: <strong style={{color:'var(--text)', fontWeight:500}}>{car.skins[skinIdx]}</strong>
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
                  {t('cars.modal.specs')}
                </div>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 14px'}}>
                  {car.specs.bhp      && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>{t('cars.modal.bhp')}</div><div style={{fontSize:13, fontWeight:500}}>{car.specs.bhp}</div></div>}
                  {car.specs.torque   && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>{t('cars.modal.torque')}</div><div style={{fontSize:13, fontWeight:500}}>{car.specs.torque}</div></div>}
                  {car.specs.weight   && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>{t('cars.modal.weight')}</div><div style={{fontSize:13, fontWeight:500}}>{car.specs.weight}</div></div>}
                  {car.specs.topspeed && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>{t('cars.modal.topspeed')}</div><div style={{fontSize:13, fontWeight:500}}>{car.specs.topspeed}</div></div>}
                </div>
              </div>
            )}

            {car.description && (
              <div>
                <div style={{fontSize:10.5, fontWeight:600, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:8}}>
                  {t('cars.modal.desc')}
                </div>
                <div style={{fontSize:11.5, color:'var(--text-muted)', lineHeight:1.65}}>
                  {car.description}
                </div>
              </div>
            )}

            {!hasSpecs && !car.description && (
              <div style={{fontSize:12.5, color:'var(--text-faint)', lineHeight:1.6}}>
                {t('cars.modal.empty')}
              </div>
            )}

            <div className="mono" style={{fontSize:10, color:'var(--text-faint)', marginTop:14, wordBreak:'break-all'}}>
              {car.id}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>{t('common.close')}</button>
          <div className="row" style={{gap:6, alignItems:'center'}}>
            {count > 0 && (
              <button className="btn btn-sm" onClick={onRemove} title={t('cars.modal.btn_remove')}>
                <I3.IconX size={12}/> {t('common.remove')}
              </button>
            )}
            <div style={{
              display:'flex', alignItems:'center', gap:8,
              padding:'4px 10px', borderRadius:'var(--radius)',
              background: count > 0 ? 'color-mix(in srgb, var(--red) 12%, transparent)' : 'var(--bg-3)',
              border: `1px solid ${count > 0 ? 'var(--red)' : 'var(--border)'}`,
              fontSize:12, fontWeight:600, color: count > 0 ? 'var(--red)' : 'var(--text-muted)',
              minWidth: 36, justifyContent:'center',
            }}>
              {count}
            </div>
            <button className="btn btn-primary btn-sm" onClick={onAdd} title={t('cars.modal.btn_add_slot')}>
              <I3.IconPlus size={12}/> {count === 0 ? t('cars.modal.btn_add') : t('cars.modal.btn_add_more')}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Car card ───────────────────────────────────────────────────────────────────
function CarCard({ car, count, onOpen, t }) {
  const skinsCount = car.skins?.length || 0;
  const [imgFailed, setImgFailed] = useStateB(false);
  const initial = (car.brand || car.name || '?').slice(0, 2).toUpperCase();

  return (
    <div className={`car-card ${count > 0 ? 'selected' : ''}`} onClick={onOpen}>
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
            justifyContent:'center', background:'var(--bg-3)', color:'var(--text-faint)',
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
        {count > 0 && (
          <div style={{
            position:'absolute', inset:0,
            background:'color-mix(in srgb, var(--red) 18%, transparent)',
            pointerEvents:'none',
          }}/>
        )}
      </div>

      <div className="car-check" style={count > 1 ? {background:'var(--red)', borderColor:'var(--red)', color:'white', width:22, height:22, fontSize:10, fontWeight:700} : {}}>
        {count > 1 ? count : (count === 1 ? <I3.IconCheck size={12}/> : null)}
      </div>

      <div className="car-meta">
        <div style={{display:'flex', alignItems:'center', gap:6, minWidth:0}}>
          {car.brandLogo && (
            <img src={car.brandLogo} alt={car.brand}
              style={{height:14, width:'auto', objectFit:'contain', flexShrink:0, opacity:0.85}}
              onError={e => { e.target.style.display='none'; }}/>
          )}
          <div className="car-name" style={{minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{car.name}</div>
        </div>
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
function TrackModal({ track, sessionCfg, setSessionCfg, onClose, t }) {
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
            <div style={{fontSize:12, color:'var(--text-muted)', marginTop:2, display:'flex', alignItems:'center', gap:5}}>
              {track.flag && <img src={track.flag} alt={track.country} style={{height:10, width:'auto', borderRadius:1, opacity:0.85}} onError={e=>{e.target.style.display='none'}}/>}
              {[track.countryEs || track.country, length > 0 ? `${length} km` : null, pits ? `${pits} pits` : null].filter(Boolean).join(' · ')}
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
                  {t('tracks.modal.data')}
                </div>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 14px'}}>
                  {length > 0 && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>{t('tracks.modal.length')}</div><div style={{fontSize:13, fontWeight:500}}>{length} km</div></div>}
                  {pits > 0   && <div><div style={{fontSize:10, color:'var(--text-faint)'}}>{t('tracks.modal.pits')}</div><div style={{fontSize:13, fontWeight:500}}>{pits}</div></div>}
                </div>
              </div>
            )}
            {desc && (
              <div>
                <div style={{fontSize:10.5, fontWeight:600, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:8}}>
                  {t('cars.modal.desc')}
                </div>
                <div style={{fontSize:11.5, color:'var(--text-muted)', lineHeight:1.65}}>{desc}</div>
              </div>
            )}
            {!desc && length === 0 && (
              <div style={{fontSize:12.5, color:'var(--text-faint)', lineHeight:1.6}}>
                {t('tracks.modal.empty')}
              </div>
            )}
            <div className="mono" style={{fontSize:10, color:'var(--text-faint)', marginTop:14, wordBreak:'break-all'}}>
              {track.id}{activeLayout ? ` / ${activeLayout}` : ''}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>{t('common.close')}</button>
          <button
            className="btn btn-primary"
            style={isActiveSelected ? {background:'transparent', borderColor:'var(--red)', color:'var(--red)'} : {}}
            onClick={selectAndClose}
          >
            {isActiveSelected
              ? <><I3.IconCheck size={12}/> {t('tracks.modal.btn_selected')}</>
              : <><I3.IconCheck size={12}/> {t('tracks.modal.btn_select')}</>
            }
          </button>
        </div>

      </div>
    </div>
  );
}

// ── Track card ────────────────────────────────────────────────────────────────
function TrackCard({ track, sessionCfg, setSessionCfg, onOpenModal, t }) {
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

  const [imgFailed, setImgFailed] = useStateB(false);
  const trackInitial = track.name.slice(0,2).toUpperCase();

  return (
    <div className={`track-card ${selected ? 'selected' : ''}`} onClick={handleClick}>
      <div className="track-thumb">
        {!imgFailed ? (
          <img src={track.thumb} alt={track.name}
            style={{width:'100%', height:'100%', objectFit:'cover'}}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div style={{
            width:'100%', height:'100%', display:'flex', alignItems:'center',
            justifyContent:'center', background:'var(--bg-3)', color:'var(--text-faint)',
          }}>
            <span style={{fontSize:20, fontWeight:700, letterSpacing:'-0.03em', opacity:0.35}}>{trackInitial}</span>
          </div>
        )}
      </div>
      <div className="track-meta">
        <div className="row-between">
          <div style={{minWidth:0}}>
            <div className="track-name">{track.name}</div>
            <div className="track-loc" style={{display:'flex', alignItems:'center', gap:4}}>
              {track.flag && (
                <img src={track.flag} alt={track.country}
                  style={{height:9, width:'auto', borderRadius:1, opacity:0.85}}
                  onError={e => { e.target.style.display='none'; }}/>
              )}
              {track.countryEs || track.country}
            </div>
          </div>
          <div style={{display:'flex', gap:4, alignItems:'center', flexShrink:0}}>
            {hasLayouts && <span className="badge" style={{fontSize:10}}>{track.layouts.length} layouts</span>}
            {selected && <span className="badge badge-red"><I3.IconCheck size={10}/> {t('tracks.card.sel')}</span>}
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
            {t('tracks.card.click', { count: track.layouts.length })}
          </div>
        )}

        <div className="mono" style={{fontSize:10.5, color:'var(--text-faint)', marginTop:8}}>{track.id}</div>
      </div>
    </div>
  );
}

// ── PageCars ──────────────────────────────────────────────────────────────────
function PageCars({ cars, sessionCfg, setSessionCfg, carsLoaded }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [query,     setQuery]     = useStateB('');
  const [brand,     setBrand]     = useStateB('all');
  const [showKunos, setShowKunos] = useStateB(true);
  const [modalCar,  setModalCar]  = useStateB(null);
  const [page,      setPage]      = useStateB(1);
  const [pageSize,  setPageSize]  = useStateB(30);

  // Default Kunos toggle off when mods are present (runs once after data loads)
  const _kunosCarInit = useRefB(false);
  useEffectB(() => {
    if (!_kunosCarInit.current && cars.length > 0) {
      _kunosCarInit.current = true;
      if (cars.some(c => !c.isKunos)) setShowKunos(false);
    }
  }, [cars]);

  // Reset page on filter change
  useEffectB(() => { setPage(1); }, [query, brand, showKunos, pageSize]);

  const kunosCount = useMemoB(() => cars.filter(c => c.isKunos).length, [cars]);
  const brands     = useMemoB(() => {
    const base = cars.filter(c => showKunos || !c.isKunos);
    return ['all', ...Array.from(new Set(base.map(c => c.brand).filter(Boolean))).sort()];
  }, [cars, showKunos]);

  const filtered = useMemoB(() => cars.filter(c => {
    if (!showKunos && c.isKunos) return false;
    if (brand !== 'all' && c.brand !== brand) return false;
    if (query && !(`${c.brand} ${c.name} ${c.id}`).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [cars, brand, query, showKunos]);

  const addCar = (id) => setSessionCfg(cfg => ({ ...cfg, carIds: [...cfg.carIds, id] }));
  const removeCar = (id) => setSessionCfg(cfg => {
    const idx = cfg.carIds.lastIndexOf(id);
    if (idx === -1) return cfg;
    const next = [...cfg.carIds];
    next.splice(idx, 1);
    return { ...cfg, carIds: next };
  });
  const carCount = (id) => sessionCfg.carIds.filter(x => x === id).length;

  const selectedCount = sessionCfg.carIds.length;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('cars.title')}</h1>
        <p className="page-sub">
          {cars.length} {t('cars.sub_count')} <span className="mono">/content/cars</span>.
          {selectedCount > 0 && <> · <strong style={{color:'var(--red)'}}>{selectedCount} {t('cars.sub_sel')}</strong></>}
        </p>
      </div>

      <div className="toolbar">
        <div className="search">
          <I3.IconSearch size={14} className="search-icon"/>
          <input className="input" placeholder={t('cars.search')} value={query} onChange={e => setQuery(e.target.value)}/>
        </div>
        {kunosCount > 0 && (
          <label className="toggle-wrap" title={t('cars.kunos_hint', { count: kunosCount })}>
            <span className="toggle-label">{t('cars.kunos')} ({kunosCount})</span>
            <span className="toggle">
              <input type="checkbox" checked={showKunos} onChange={e => setShowKunos(e.target.checked)}/>
              <span className="toggle-track"></span>
              <span className="toggle-thumb"></span>
            </span>
          </label>
        )}
        <div className="right row" style={{gap: 6}}>
          {selectedCount > 0 && (
            <button className="btn btn-sm" onClick={() => setSessionCfg(c => ({...c, carIds: []}))}>
              <I3.IconX size={11}/> {t('cars.btn_clear')}
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setSessionCfg(c => ({...c, carIds: filtered.map(x => x.id)}))}>
            {t('cars.btn_select_all')}
          </button>
        </div>
      </div>
      {brands.length > 1 && (
        <div className="toolbar" style={{paddingTop: 0, gap: 8, flexWrap:'wrap'}}>
          <div className="tag-row" style={{flexWrap:'wrap'}}>
            <span style={{fontSize:11, color:'var(--text-faint)', marginRight:2}}>{t('cars.brand')}:</span>
            {brands.map(b => (
              <button key={b} className={`tag ${brand === b ? 'active' : ''}`} onClick={() => setBrand(b)}>
                {b === 'all' ? t('cars.brand_all') : b}
              </button>
            ))}
          </div>
          <div className="right row" style={{gap:6, alignItems:'center'}}>
            <span style={{fontSize:11, color:'var(--text-faint)'}}>{t('common.per_page')}:</span>
            {[15,30,50].map(n => (
              <button key={n} className={`tag ${pageSize===n?'active':''}`} style={{padding:'2px 8px'}} onClick={()=>setPageSize(n)}>{n}</button>
            ))}
          </div>
        </div>
      )}

      {!carsLoaded && cars.length === 0 ? (
        <div className="card">
          <div className="loading-row">
            <div style={{width:18,height:18,borderRadius:'50%',border:'2px solid var(--border)',borderTopColor:'var(--red)',animation:'spin 0.8s linear infinite'}}></div>
            {t('common.loading')}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty">{t('common.not_found')}</div></div>
      ) : (() => {
        const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
        const safePage   = Math.min(page, totalPages);
        const slice      = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
        return (
          <>
            <div className="car-grid">
              {slice.map(c => (
                <CarCard
                  key={c.id}
                  car={c}
                  count={carCount(c.id)}
                  onOpen={() => setModalCar(c)}
                />
              ))}
            </div>
            {totalPages > 1 && (
              <div className="pagination">
                <button className="btn btn-sm" disabled={safePage === 1} onClick={() => setPage(1)}>«</button>
                <button className="btn btn-sm" disabled={safePage === 1} onClick={() => setPage(p => p - 1)}>‹</button>
                <span className="pagination-info">{t('times.page_of', { page: safePage, totalPages })}</span>
                <button className="btn btn-sm" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
                <button className="btn btn-sm" disabled={safePage === totalPages} onClick={() => setPage(totalPages)}>»</button>
              </div>
            )}
          </>
        );
      })()}

      {modalCar && (
        <CarModal
          car={modalCar}
          count={carCount(modalCar.id)}
          onAdd={() => addCar(modalCar.id)}
          onRemove={() => removeCar(modalCar.id)}
          onClose={() => setModalCar(null)}
          t={t}
        />
      )}
    </>
  );
}

// ── PageTracks ────────────────────────────────────────────────────────────────
function PageTracks({ tracks, sessionCfg, setSessionCfg, tracksLoaded }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [query,      setQuery]      = useStateB('');
  const [country,    setCountry]    = useStateB('all');
  const [showKunos,  setShowKunos]  = useStateB(true);
  const [modalTrack, setModalTrack] = useStateB(null);
  const [page,       setPage]       = useStateB(1);
  const [pageSize,   setPageSize]   = useStateB(30);

  // Default Kunos toggle off when mods are present (runs once after data loads)
  const _kunosTrackInit = useRefB(false);
  useEffectB(() => {
    if (!_kunosTrackInit.current && tracks.length > 0) {
      _kunosTrackInit.current = true;
      if (tracks.some(t => !t.isKunos)) setShowKunos(false);
    }
  }, [tracks]);

  useEffectB(() => { setPage(1); }, [query, country, showKunos, pageSize]);

  const kunosCount = useMemoB(() => tracks.filter(t => t.isKunos).length, [tracks]);
  const countries  = useMemoB(() => {
    const base = tracks.filter(t => showKunos || !t.isKunos);
    return ['all', ...Array.from(new Set(base.map(t => t.countryEs || t.country).filter(Boolean))).sort()];
  }, [tracks, showKunos]);

  const filtered = useMemoB(() => tracks.filter(t => {
    if (!showKunos && t.isKunos) return false;
    if (country !== 'all' && (t.countryEs || t.country) !== country) return false;
    if (query && !(t.name + ' ' + (t.countryEs || t.country) + ' ' + t.id).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [tracks, country, query, showKunos]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('tracks.title')}</h1>
        <p className="page-sub">{tracks.length} {t('tracks.sub')} <span className="mono">/content/tracks</span>. {t('tracks.sub_select')}</p>
      </div>

      <div className="toolbar">
        <div className="search">
          <I3.IconSearch size={14} className="search-icon"/>
          <input className="input" placeholder={t('tracks.search')} value={query} onChange={e => setQuery(e.target.value)}/>
        </div>
        {kunosCount > 0 && (
          <label className="toggle-wrap" title={t('tracks.kunos_hint', { count: kunosCount })}>
            <span className="toggle-label">{t('tracks.kunos')} ({kunosCount})</span>
            <span className="toggle">
              <input type="checkbox" checked={showKunos} onChange={e => setShowKunos(e.target.checked)}/>
              <span className="toggle-track"></span>
              <span className="toggle-thumb"></span>
            </span>
          </label>
        )}
      </div>
      {countries.length > 1 && (
        <div className="toolbar" style={{paddingTop: 0, gap: 8, flexWrap:'wrap'}}>
          <div className="tag-row" style={{flexWrap:'wrap'}}>
            <span style={{fontSize:11, color:'var(--text-faint)', marginRight:2}}>{t('tracks.country')}:</span>
            {countries.map(c => (
              <button key={c} className={`tag ${country === c ? 'active' : ''}`} onClick={() => setCountry(c)}>
                {c === 'all' ? t('tracks.country_all') : c}
              </button>
            ))}
          </div>
          <div className="right row" style={{gap:6, alignItems:'center'}}>
            <span style={{fontSize:11, color:'var(--text-faint)'}}>{t('common.per_page')}:</span>
            {[15,30,50].map(n => (
              <button key={n} className={`tag ${pageSize===n?'active':''}`} style={{padding:'2px 8px'}} onClick={()=>setPageSize(n)}>{n}</button>
            ))}
          </div>
        </div>
      )}

      {!tracksLoaded && tracks.length === 0 ? (
        <div className="card">
          <div className="loading-row">
            <div style={{width:18,height:18,borderRadius:'50%',border:'2px solid var(--border)',borderTopColor:'var(--red)',animation:'spin 0.8s linear infinite'}}></div>
            {t('common.loading')}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card"><div className="empty">{t('common.not_found')}</div></div>
      ) : (() => {
        const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
        const safePage   = Math.min(page, totalPages);
        const slice      = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
        return (
          <>
            <div className="track-grid">
              {slice.map(trk => (
                <TrackCard key={trk.id} track={trk} sessionCfg={sessionCfg} setSessionCfg={setSessionCfg} onOpenModal={setModalTrack} t={t}/>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="pagination">
                <button className="btn btn-sm" disabled={safePage === 1} onClick={() => setPage(1)}>«</button>
                <button className="btn btn-sm" disabled={safePage === 1} onClick={() => setPage(p => p - 1)}>‹</button>
                <span className="pagination-info">{t('times.page_of', { page: safePage, totalPages })}</span>
                <button className="btn btn-sm" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
                <button className="btn btn-sm" disabled={safePage === totalPages} onClick={() => setPage(totalPages)}>»</button>
              </div>
            )}
          </>
        );
      })()}

      {modalTrack && (
        <TrackModal
          track={modalTrack}
          sessionCfg={sessionCfg}
          setSessionCfg={setSessionCfg}
          onClose={() => setModalTrack(null)}
          t={t}
        />
      )}
    </>
  );
}

// ── PageSession ───────────────────────────────────────────────────────────────
function PageSession({ tracks, cars, sessionCfg, setSessionCfg, isAdmin, onApply }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [confirmApply, setConfirmApply] = useStateB(false);
  const track        = tracks.find(t => t.id === sessionCfg.trackId);
  // Build unique car list with counts (preserves order of first appearance)
  const selectedCars = useMemoB(() => {
    const seen = new Map();
    for (const id of sessionCfg.carIds) {
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    return Array.from(seen.entries()).map(([id, cnt]) => ({
      car: cars.find(c => c.id === id) || { id, name: id, brand: '', thumb: null },
      cnt,
    }));
  }, [sessionCfg.carIds, cars]);
  const set = (k, v) => setSessionCfg(c => ({...c, [k]: v}));

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('sess.title')}</h1>
        <p className="page-sub">{t('sess.sub')}</p>
      </div>

      <div className="grid-2" style={{gridTemplateColumns: '1.4fr 1fr', alignItems: 'start'}}>
        <div className="col" style={{gap: 16}}>
          <div className="card">
            <div className="card-header">
              <I3.IconFlag size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">{t('sess.mode_title')}</div>
            </div>
            <div className="card-body col" style={{gap: 16}}>
              <div className="field">
                <label className="field-label">{t('sess.mode')}</label>
                <div className="segmented" style={{alignSelf: 'flex-start'}}>
                  {['Practice', 'Qualify', 'Race'].map(m => (
                    <button key={m} className={sessionCfg.mode === m ? 'active' : ''} onClick={() => set('mode', m)}>{m}</button>
                  ))}
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">{sessionCfg.mode === 'Race' ? t('sess.laps') : t('sess.duration')}</label>
                  <input className="input" type="number" inputMode="numeric" min="1" value={sessionCfg.laps} onChange={e => set('laps', Number(e.target.value))} disabled={!isAdmin}/>
                </div>
                <div className="field">
                  <label className="field-label">{t('sess.slots')}</label>
                  <input className="input" type="number" inputMode="numeric" min="2" max="64" value={sessionCfg.slots} onChange={e => set('slots', Number(e.target.value))} disabled={!isAdmin}/>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <I3.IconCloud size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">{t('sess.cond_title')}</div>
            </div>
            <div className="card-body col" style={{gap: 16}}>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">{t('sess.time')}</label>
                  <div className="row" style={{gap: 10}}>
                    <input type="range" min="0" max="23" value={sessionCfg.time} onChange={e => set('time', Number(e.target.value))} style={{flex: 1, accentColor: 'var(--red)'}} disabled={!isAdmin}/>
                    <div className="mono" style={{minWidth: 44, textAlign:'right'}}>{String(sessionCfg.time).padStart(2,'0')}:00</div>
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">{t('sess.weather')}</label>
                  <select className="select" value={sessionCfg.weather} onChange={e => set('weather', e.target.value)} disabled={!isAdmin}>
                    <option>Clear</option><option>Cloudy</option>
                    <option>Fog</option><option>Light Rain</option>
                    <option>Thunderstorm</option>
                  </select>
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">{t('sess.temp')}: {sessionCfg.airTemp}°C</label>
                  <input type="range" min="5" max="40" value={sessionCfg.airTemp} onChange={e => set('airTemp', Number(e.target.value))} style={{accentColor: 'var(--red)'}} disabled={!isAdmin}/>
                </div>
                <div className="field">
                  <label className="field-label">{t('sess.damage')}: {sessionCfg.damage}%</label>
                  <input type="range" min="0" max="100" step="10" value={sessionCfg.damage} onChange={e => set('damage', Number(e.target.value))} style={{accentColor: 'var(--red)'}} disabled={!isAdmin}/>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <I3.IconShield size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">{t('sess.assist_title')}</div>
            </div>
            <div className="card-body col" style={{gap: 12}}>
              {[
                ['ABS', 'abs'], [t('sess.tc'), 'tc'], [t('sess.auto_shift'), 'autoShift'],
                [t('sess.ideal_line'), 'ideal'], [t('sess.penalties'), 'penalties'],
                [t('sess.tire_wear'), 'tireWear'], [t('sess.fuel'), 'fuel'],
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
              <div className="card-title">{t('sess.track_title')}</div>
            </div>
            {track ? (
              <div style={{padding: '0 18px 14px'}}>
                <div style={{borderRadius: 6, overflow:'hidden', background: 'var(--bg-3)', marginTop: 14}}>
                  <img src={track.thumb} style={{width:'100%', display:'block'}}
                    onError={e => { e.target.style.display='none'; }}/>
                </div>
                <div style={{marginTop: 12}}>
                  <div style={{fontSize: 14, fontWeight: 600}}>{track.name}</div>
                  <div className="muted" style={{fontSize: 12}}>{track.countryEs || track.country} · {track.length} km</div>
                </div>
                <div className="field" style={{marginTop: 12}}>
                  <label className="field-label">Layout</label>
                  <select className="select" value={sessionCfg.layout} onChange={e => set('layout', e.target.value)} disabled={!isAdmin}>
                    {track.layouts.map(l => <option key={l} value={l}>{l || 'Default'}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div className="empty">{t('sess.no_track')}</div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <I3.IconCar size={14} style={{color:'var(--red)'}}/>
              <div className="card-title">{t('sess.cars_title')}</div>
              <span className="badge right">{sessionCfg.carIds.length} slots</span>
            </div>
            <div style={{maxHeight: 220, overflowY: 'auto'}}>
              {selectedCars.length === 0 ? (
                <div className="empty" style={{padding: '28px 20px'}}>
                  {t('sess.no_cars')}
                </div>
              ) : selectedCars.map(({car: c, cnt}) => (
                <div key={c.id} style={{display:'flex', alignItems:'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border)'}}>
                  <div style={{width: 36, height: 22, borderRadius: 3, overflow:'hidden', background: 'var(--bg-3)', flexShrink: 0}}>
                    {c.thumb && <img src={c.thumb} style={{width:'100%', height:'100%', objectFit:'cover'}}
                      onError={e => { e.target.style.display='none'; }}/>}
                  </div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div style={{fontSize: 12.5, fontWeight: 500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{c.name}</div>
                    <div className="muted" style={{fontSize: 11}}>{c.brand}</div>
                  </div>
                  {cnt > 1 && (
                    <span className="badge" style={{fontSize:10, fontWeight:600, background:'color-mix(in srgb, var(--red) 12%, transparent)', color:'var(--red)', border:'1px solid var(--red)'}}>×{cnt}</span>
                  )}
                  <button className="icon-btn" style={{width: 24, height: 24}}
                    onClick={() => setSessionCfg(s => ({...s, carIds: s.carIds.filter(x => x !== c.id)}))}>
                    <I3.IconX size={12}/>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {isAdmin && (
            <button className="btn btn-primary" style={{padding: '10px', justifyContent:'center'}} onClick={()=>setConfirmApply(true)}>
              <I3.IconCheck size={14}/> {t('sess.btn_apply')}
            </button>
          )}
        </div>
      </div>

      {confirmApply && (
        <div className="modal-backdrop" onClick={()=>setConfirmApply(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <I3.IconFlag size={15} style={{color:'var(--red)'}}/>
              <div className="modal-title">{t('sess.modal.title')}</div>
            </div>
            <div className="modal-body">
              <p style={{margin:0, fontSize:13, color:'var(--text-muted)'}}>
                {t('sess.modal.msg').split('<br>').map((line, i, arr) => (
                  <React.Fragment key={i}>{line}{i < arr.length - 1 && <br/>}</React.Fragment>
                ))}
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={()=>setConfirmApply(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={()=>{ onApply(); setConfirmApply(false); }}>
                <I3.IconCheck size={13}/> {t('sess.modal.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

window.AppPagesContent = { PageCars, PageTracks, PageSession };
