// Page: Cars catalogue + selection. Tracks and Session live in sibling files
// (`tracks.jsx`, `session.jsx`); each pushes its component into the shared
// `window.AppPagesContent` namespace so app.jsx still consumes a single
// destructure.
const { useState: useStateB, useMemo: useMemoB, useEffect: useEffectB, useRef: useRefB } = React;
const I3 = window.AppIcons;

// Spinner-overlay → fade-in <img> wrapper. Compares `loadedSrc === src`
// synchronously instead of leaning on a useEffect reset, so swapping the
// `src` mid-mount (clicking a different skin thumbnail in the modal)
// flips back to "not loaded" in the same render that the new src lands —
// no frame where the partially-decoded new image is visible at opacity 1.
function LoadingImg({ src, alt, style, fallback = null }) {
  const [loadedSrc, setLoadedSrc] = useStateB(null);
  const [failedSrc, setFailedSrc] = useStateB(null);
  const isLoaded = loadedSrc === src;
  const isFailed = failedSrc === src;
  if (!src || isFailed) return fallback;
  return (
    <div style={{position:'relative', width:'100%', height:'100%', overflow:'hidden'}}>
      {!isLoaded && (
        <div style={{
          position:'absolute', inset:0, display:'flex', alignItems:'center',
          justifyContent:'center', background:'var(--bg-3)',
        }}>
          <div style={{
            width:18, height:18, borderRadius:'50%',
            border:'2px solid var(--border)', borderTopColor:'var(--red)',
            animation:'spin 0.8s linear infinite',
          }}/>
        </div>
      )}
      <img
        src={src} alt={alt}
        style={{
          width:'100%', height:'100%', objectFit:'cover', display:'block',
          opacity: isLoaded ? 1 : 0, transition:'opacity 180ms ease-out',
          ...style,
        }}
        onLoad={() => setLoadedSrc(src)}
        onError={() => setFailedSrc(src)}
      />
    </div>
  );
}

// ── Car modal ─────────────────────────────────────────────────────────────────
function CarModal({ car, count, currentSkin, onAdd, onRemove, onClose, onDelete, isAdmin, t }) {
  const ConfirmModal = window.AppPagesSettings && window.AppPagesSettings.ConfirmModal;
  const [confirmDelete, setConfirmDelete] = useStateB(false);
  // Preselect the skin the admin previously chose for this car (if any) so
  // reopening the modal doesn't lose context.
  const initialIdx = useMemoB(() => {
    if (!currentSkin || !car.skins) return 0;
    const i = car.skins.indexOf(currentSkin);
    return i >= 0 ? i : 0;
  }, [currentSkin, car.skins]);
  const [skinIdx, setSkinIdx] = useStateB(initialIdx);

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
              <LoadingImg src={imgSrc} alt={hasSkins ? car.skins[skinIdx] : car.name} />
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
                    <LoadingImg
                      src={`/api/content/cars/${encodeURIComponent(car.id)}/skins/${encodeURIComponent(skin)}/preview`}
                      alt={skin}
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
            {isAdmin && !car.isKunos && onDelete && (
              <button
                className="btn btn-sm btn-danger"
                title={t('cars.delete.btn')}
                onClick={() => setConfirmDelete(true)}
              >
                <I3.IconTrash size={12}/> {t('common.delete')}
              </button>
            )}
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
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onAdd(hasSkins ? car.skins[skinIdx] : null)}
              title={t('cars.modal.btn_add_slot')}
            >
              <I3.IconPlus size={12}/> {count === 0 ? t('cars.modal.btn_add') : t('cars.modal.btn_add_more')}
            </button>
          </div>
        </div>

      </div>
      {confirmDelete && ConfirmModal && (
        <ConfirmModal
          title={t('cars.delete.btn')}
          message={t('cars.delete.confirm', { name: car.name })}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); onDelete().then(() => onClose()).catch(() => {}); }}
        />
      )}
    </div>
  );
}

// ── Car card ───────────────────────────────────────────────────────────────────
function CarCard({ car, count, onOpen, t }) {
  const skinsCount = car.skins?.length || 0;
  const [imgFailed, setImgFailed] = useStateB(false);
  const [imgLoaded, setImgLoaded] = useStateB(false);
  const initial = (car.brand || car.name || '?').slice(0, 2).toUpperCase();

  return (
    <div className={`car-card ${count > 0 ? 'selected' : ''}`} onClick={onOpen}>
      <div className="car-thumb" style={{position:'relative', overflow:'hidden'}}>
        {car.thumb && !imgFailed ? (
          <>
            {!imgLoaded && (
              <div style={{
                position:'absolute', inset:0, display:'flex', alignItems:'center',
                justifyContent:'center', background:'var(--bg-3)',
              }}>
                <div style={{
                  width:18, height:18, borderRadius:'50%',
                  border:'2px solid var(--border)', borderTopColor:'var(--red)',
                  animation:'spin 0.8s linear infinite',
                }}/>
              </div>
            )}
            <img
              src={car.thumb}
              alt={car.name}
              style={{
                width:'100%', height:'100%', objectFit:'cover',
                opacity: imgLoaded ? 1 : 0, transition:'opacity 180ms ease-out',
              }}
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgFailed(true)}
            />
          </>
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

// ── PageCars ──────────────────────────────────────────────────────────────────
function PageCars({ cars, sessionCfg, setSessionCfg, carsLoaded, isAdmin, onDelete }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [query,     setQuery]     = useStateB('');
  const [brand,     setBrand]     = useStateB('all');
  const [showKunos, setShowKunos] = useStateB(true);
  const [showMods,  setShowMods]  = useStateB(true);
  const [modalCar,  setModalCar]  = useStateB(null);
  const [page,      setPage]      = useStateB(1);
  const [pageSize,  setPageSize]  = useStateB(10);

  // First time cars are loaded, auto-hide Kunos content if there's at least
  // one mod — admins of modded servers usually only browse the mods.
  const _kunosCarInit = useRefB(false);
  useEffectB(() => {
    if (!_kunosCarInit.current && cars.length > 0) {
      _kunosCarInit.current = true;
      if (cars.some(c => !c.isKunos)) setShowKunos(false);
    }
  }, [cars]);

  // Reset page on filter change
  useEffectB(() => { setPage(1); }, [query, brand, showKunos, showMods, pageSize]);

  const kunosCount = useMemoB(() => cars.filter(c =>  c.isKunos).length, [cars]);
  const modsCount  = useMemoB(() => cars.filter(c => !c.isKunos).length, [cars]);
  const brands     = useMemoB(() => {
    const base = cars.filter(c => (showKunos && c.isKunos) || (showMods && !c.isKunos));
    return ['all', ...Array.from(new Set(base.map(c => c.brand).filter(Boolean))).sort()];
  }, [cars, showKunos, showMods]);

  const filtered = useMemoB(() => cars.filter(c => {
    if ( c.isKunos && !showKunos) return false;
    if (!c.isKunos && !showMods)  return false;
    if (brand !== 'all' && c.brand !== brand) return false;
    if (query && !(`${c.brand} ${c.name} ${c.id}`).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [cars, brand, query, showKunos, showMods]);

  // Each "Add to slot" pushes a new {id, skin} onto the ordered slots array,
  // so the same car can appear multiple times with different skins (FK2 blue
  // and FK2 red as two distinct grid slots).
  const addCar = (id, skin) => setSessionCfg(cfg => ({
    ...cfg,
    slots: [...(cfg.slots || []), { id, skin: skin || null }],
  }));
  // Remove the last occurrence of this car id (the one most recently added).
  const removeCar = (id) => setSessionCfg(cfg => {
    const cur = cfg.slots || [];
    let idx = -1;
    for (let i = cur.length - 1; i >= 0; i--) { if (cur[i].id === id) { idx = i; break; } }
    if (idx === -1) return cfg;
    const next = [...cur];
    next.splice(idx, 1);
    return { ...cfg, slots: next };
  });
  const carCount = (id) => (sessionCfg.slots || []).filter(x => x.id === id).length;
  // Look up the skin of the most recent slot for this car id — used to
  // pre-fill the modal so reopening the same car shows the last choice.
  const lastSkinOf = (id) => {
    const cur = sessionCfg.slots || [];
    for (let i = cur.length - 1; i >= 0; i--) if (cur[i].id === id) return cur[i].skin || null;
    return null;
  };

  const selectedCount = (sessionCfg.slots || []).length;

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
        {modsCount > 0 && (
          <label className="toggle-wrap" title={t('cars.mods_hint', { count: modsCount })}>
            <span className="toggle-label">{t('cars.mods')} ({modsCount})</span>
            <span className="toggle">
              <input type="checkbox" checked={showMods} onChange={e => setShowMods(e.target.checked)}/>
              <span className="toggle-track"></span>
              <span className="toggle-thumb"></span>
            </span>
          </label>
        )}
        <div className="right row" style={{gap: 6}}>
          {selectedCount > 0 && (
            <button className="btn btn-sm" onClick={() => setSessionCfg(c => ({...c, slots: []}))}>
              <I3.IconX size={11}/> {t('cars.btn_clear')}
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setSessionCfg(c => ({...c, slots: filtered.map(x => ({id: x.id, skin: null}))}))}>
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
            {[10,20,30].map(n => (
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
          currentSkin={lastSkinOf(modalCar.id)}
          onAdd={(skin) => addCar(modalCar.id, skin)}
          onRemove={() => removeCar(modalCar.id)}
          onClose={() => setModalCar(null)}
          isAdmin={isAdmin}
          onDelete={onDelete ? () => onDelete(modalCar.id) : null}
          t={t}
        />
      )}
    </>
  );
}

window.AppPagesContent = window.AppPagesContent || {};
window.AppPagesContent.PageCars = PageCars;
