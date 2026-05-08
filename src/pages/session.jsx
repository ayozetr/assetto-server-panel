// Page: Session config (mode, conditions, assists, track + car summary).
// Split out of content.jsx for size. Publishes into the shared
// `window.AppPagesContent` namespace.
const { useState: useStateS, useMemo: useMemoS } = React;
const I3S = window.AppIcons;

// ── PageSession ───────────────────────────────────────────────────────────────
function PageSession({ tracks, cars, sessionCfg, setSessionCfg, isAdmin, onApply }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [confirmApply, setConfirmApply] = useStateS(false);
  const track        = tracks.find(t => t.id === sessionCfg.trackId);
  // Build unique car list with counts (preserves order of first appearance)
  const selectedCars = useMemoS(() => {
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
              <I3S.IconFlag size={14} style={{color:'var(--red)'}}/>
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
              <I3S.IconCloud size={14} style={{color:'var(--red)'}}/>
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
              <I3S.IconShield size={14} style={{color:'var(--red)'}}/>
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
              <I3S.IconTrack size={14} style={{color:'var(--red)'}}/>
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
              <I3S.IconCar size={14} style={{color:'var(--red)'}}/>
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
                    <I3S.IconX size={12}/>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {isAdmin && (
            <button className="btn btn-primary" style={{padding: '10px', justifyContent:'center'}} onClick={()=>setConfirmApply(true)}>
              <I3S.IconCheck size={14}/> {t('sess.btn_apply')}
            </button>
          )}
        </div>
      </div>

      {confirmApply && (
        <div className="modal-backdrop" onClick={()=>setConfirmApply(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <I3S.IconFlag size={15} style={{color:'var(--red)'}}/>
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
                <I3S.IconCheck size={13}/> {t('sess.modal.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

window.AppPagesContent = window.AppPagesContent || {};
window.AppPagesContent.PageSession = PageSession;
