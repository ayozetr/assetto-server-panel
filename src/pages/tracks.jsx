// Page: Tracks catalogue. Split out of content.jsx for size; the cars,
// tracks and session sub-pages used to share one 947-line file. The
// `PageTracks` symbol is published into `window.AppPagesContent` along
// with PageCars and PageSession so the consumer in app.jsx still
// destructures a single namespace.
const { useState: useStateT, useMemo: useMemoT, useEffect: useEffectT, useRef: useRefT } = React;
const I3T = window.AppIcons;

// Spinner-overlay → fade-in <img> wrapper. Compares `loadedSrc === src`
// synchronously instead of leaning on a useEffect reset, so swapping the
// `src` mid-mount (clicking a different layout thumbnail in the modal)
// flips back to "not loaded" in the same render that the new src lands —
// no frame where the partially-decoded new image is visible at opacity 1.
function LoadingImg({ src, alt, style, fallback = null }) {
  const [loadedSrc, setLoadedSrc] = useStateT(null);
  const [failedSrc, setFailedSrc] = useStateT(null);
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

// ── Track modal (multi-layout tracks) ─────────────────────────────────────────
function TrackModal({ track, sessionCfg, setSessionCfg, onClose, onDelete, isAdmin, t }) {
  const isSelected    = sessionCfg.trackId === track.id;
  const hasLayouts    = track.layouts.length > 1;
  const [activeLayout, setActiveLayout] = useStateT(
    isSelected ? (sessionCfg.layout || track.layouts[0] || '') : (track.layouts[0] || '')
  );

  useEffectT(() => {
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
          <button className="icon-btn" onClick={onClose}><I3T.IconX size={14}/></button>
        </div>

        <div style={{display:'grid', gridTemplateColumns:'54% 46%', minHeight:240}}>

          {/* Left: track preview + layout thumbnails */}
          <div style={{padding:18, borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:12}}>
            <div style={{borderRadius:6, overflow:'hidden', background:'var(--bg-3)', height:160, flexShrink:0}}>
              <LoadingImg src={thumbSrc} alt={name} />
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
                        <LoadingImg src={lThumb} alt={l} />
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
          <div className="row" style={{gap:6, alignItems:'center'}}>
            {isAdmin && !track.isKunos && onDelete && (
              <button
                className="btn btn-sm btn-danger"
                title={t('tracks.delete.btn')}
                onClick={() => {
                  if (!window.confirm(t('tracks.delete.confirm', { name: track.name }))) return;
                  onDelete().then(() => onClose()).catch(() => {});
                }}
              >
                <I3T.IconTrash size={12}/> {t('common.delete')}
              </button>
            )}
            <button
              className="btn btn-primary"
              style={isActiveSelected ? {background:'transparent', borderColor:'var(--red)', color:'var(--red)'} : {}}
              onClick={selectAndClose}
            >
              {isActiveSelected
                ? <><I3T.IconCheck size={12}/> {t('tracks.modal.btn_selected')}</>
                : <><I3T.IconCheck size={12}/> {t('tracks.modal.btn_select')}</>
              }
            </button>
          </div>
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

  const [imgFailed, setImgFailed] = useStateT(false);
  const [imgLoaded, setImgLoaded] = useStateT(false);
  const trackInitial = track.name.slice(0,2).toUpperCase();

  return (
    <div className={`track-card ${selected ? 'selected' : ''}`} onClick={handleClick}>
      <div className="track-thumb" style={{position:'relative', overflow:'hidden'}}>
        {!imgFailed ? (
          <>
            {!imgLoaded && (
              <div style={{
                position:'absolute', inset:0, display:'flex', alignItems:'center',
                justifyContent:'center', background:'var(--bg-3)',
              }}>
                <div style={{
                  width:20, height:20, borderRadius:'50%',
                  border:'2px solid var(--border)', borderTopColor:'var(--red)',
                  animation:'spin 0.8s linear infinite',
                }}/>
              </div>
            )}
            <img src={track.thumb} alt={track.name}
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
            {selected && <span className="badge badge-red"><I3T.IconCheck size={10}/> {t('tracks.card.sel')}</span>}
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

// ── PageTracks ────────────────────────────────────────────────────────────────
function PageTracks({ tracks, sessionCfg, setSessionCfg, tracksLoaded, isAdmin, onDelete }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [query,      setQuery]      = useStateT('');
  const [country,    setCountry]    = useStateT('all');
  const [showKunos,  setShowKunos]  = useStateT(true);
  const [showMods,   setShowMods]   = useStateT(true);
  const [modalTrack, setModalTrack] = useStateT(null);
  const [page,       setPage]       = useStateT(1);
  const [pageSize,   setPageSize]   = useStateT(10);

  // First time tracks are loaded, auto-hide Kunos content if there's at least
  // one mod track — admins of modded servers usually only browse the mods.
  const _kunosTrackInit = useRefT(false);
  useEffectT(() => {
    if (!_kunosTrackInit.current && tracks.length > 0) {
      _kunosTrackInit.current = true;
      if (tracks.some(t => !t.isKunos)) setShowKunos(false);
    }
  }, [tracks]);

  useEffectT(() => { setPage(1); }, [query, country, showKunos, showMods, pageSize]);

  const kunosCount = useMemoT(() => tracks.filter(t =>  t.isKunos).length, [tracks]);
  const modsCount  = useMemoT(() => tracks.filter(t => !t.isKunos).length, [tracks]);
  const countries  = useMemoT(() => {
    const base = tracks.filter(t => (showKunos && t.isKunos) || (showMods && !t.isKunos));
    return ['all', ...Array.from(new Set(base.map(t => t.countryEs || t.country).filter(Boolean))).sort()];
  }, [tracks, showKunos, showMods]);

  const filtered = useMemoT(() => tracks.filter(t => {
    if ( t.isKunos && !showKunos) return false;
    if (!t.isKunos && !showMods)  return false;
    if (country !== 'all' && (t.countryEs || t.country) !== country) return false;
    if (query && !(t.name + ' ' + (t.countryEs || t.country) + ' ' + t.id).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [tracks, country, query, showKunos, showMods]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('tracks.title')}</h1>
        <p className="page-sub">{tracks.length} {t('tracks.sub')} <span className="mono">/content/tracks</span>. {t('tracks.sub_select')}</p>
      </div>

      <div className="toolbar">
        <div className="search">
          <I3T.IconSearch size={14} className="search-icon"/>
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
        {modsCount > 0 && (
          <label className="toggle-wrap" title={t('tracks.mods_hint', { count: modsCount })}>
            <span className="toggle-label">{t('tracks.mods')} ({modsCount})</span>
            <span className="toggle">
              <input type="checkbox" checked={showMods} onChange={e => setShowMods(e.target.checked)}/>
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
            {[10,20,30].map(n => (
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
          isAdmin={isAdmin}
          onDelete={onDelete ? () => onDelete(modalTrack.id) : null}
          t={t}
        />
      )}
    </>
  );
}

window.AppPagesContent = window.AppPagesContent || {};
window.AppPagesContent.PageTracks = PageTracks;
