// Page: Session config (mode + duration, conditions, track + car summary).
// Split out of content.jsx for size. Publishes into the shared
// `window.AppPagesContent` namespace.
const { useState: useStateS, useMemo: useMemoS } = React;
const I3S = window.AppIcons;

// ── PageSession ───────────────────────────────────────────────────────────────
function PageSession({ tracks, cars, sessionCfg, setSessionCfg, isAdmin, canEdit = isAdmin, onApply }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [confirmApply, setConfirmApply] = useStateS(false);
  const track        = tracks.find(t => t.id === sessionCfg.trackId);
  // Resolve each slot to its car metadata so the list can render thumbs and
  // brand info. We keep the ordering exactly as stored — each row = one slot.
  const slots = sessionCfg.slots || [];
  const slotCars = useMemoS(() =>
    slots.map((slot, idx) => ({
      idx,
      slot,
      car: cars.find(c => c.id === slot.id) || { id: slot.id, name: slot.id, brand: '', thumb: null },
    })), [slots, cars]);
  const set = (k, v) => setSessionCfg(c => ({...c, [k]: v}));

  // Three session rows side-by-side — each is independent: enable toggle plus
  // its own duration/laps input. acServer cycles every section present in the
  // INI; disabling a row removes its section so the cycle stays on whatever
  // is on. At least one has to stay enabled.
  const sessionRows = [
    { key: 'Practice', flag: 'practiceEnabled', value: 'practiceTime', unit: 'min',     label: t('sess.row.practice') },
    { key: 'Qualify',  flag: 'qualifyEnabled',  value: 'qualifyTime',  unit: 'min',     label: t('sess.row.qualify')  },
    { key: 'Race',     flag: 'raceEnabled',     value: 'raceLaps',     unit: 'laps',    label: t('sess.row.race')     },
  ];
  const anyEnabled = sessionRows.some(r => sessionCfg[r.flag]);

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
            <div className="card-body col" style={{gap: 12}}>
              {sessionRows.map(row => {
                const enabled = !!sessionCfg[row.flag];
                return (
                  <div key={row.key} className="row" style={{gap: 12, alignItems: 'center'}}>
                    {window.AppShell.Switch ? (
                      <window.AppShell.Switch
                        on={enabled}
                        disabled={!canEdit}
                        ariaLabel={row.label}
                        style={{flexShrink: 0}}
                        onChange={v => set(row.flag, v)}
                      />
                    ) : (
                      <div className={`switch ${enabled ? 'on' : ''}`} style={{flexShrink: 0}}
                        onClick={() => canEdit && set(row.flag, !enabled)}/>
                    )}
                    <div style={{flex: 1, fontSize: 13, fontWeight: 500, opacity: enabled ? 1 : 0.5}}>{row.label}</div>
                    <input
                      className="input" type="number" inputMode="numeric" min="1" max="9999"
                      style={{width: 90, opacity: enabled ? 1 : 0.5}}
                      value={sessionCfg[row.value] ?? 0}
                      onChange={e => {
                        const n = Number(e.target.value);
                        // Clamp client-side mirroring the server's clampInt(1..9999). Bare
                        // Number('') is NaN and would propagate to the body; coalesce to 1.
                        if (Number.isFinite(n)) set(row.value, Math.max(1, Math.min(9999, Math.round(n))));
                      }}
                      disabled={!canEdit || !enabled}
                    />
                    <div className="muted" style={{fontSize: 11, width: 36, opacity: enabled ? 1 : 0.5}}>
                      {row.unit === 'laps' ? t('sess.unit.laps') : t('sess.unit.min')}
                    </div>
                  </div>
                );
              })}
              {!anyEnabled && (
                <div className="muted" style={{fontSize: 11.5, color: 'var(--red)'}}>{t('sess.no_session_enabled')}</div>
              )}
              <div className="field" style={{marginTop: 4}}>
                <label className="field-label">{t('sess.slots')}</label>
                <input className="input" type="number" inputMode="numeric" min="2" max="64"
                  value={sessionCfg.maxClients}
                  onChange={e => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) set('maxClients', Math.max(2, Math.min(64, Math.round(n))));
                  }}
                  disabled={!canEdit} style={{maxWidth: 120}}/>
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
                    <input type="range" min="0" max="23" value={sessionCfg.time} onChange={e => set('time', Number(e.target.value))} disabled={!canEdit} style={{flex: 1, accentColor: 'var(--red)'}}/>
                    <div className="mono" style={{minWidth: 44, textAlign:'right'}}>{String(sessionCfg.time).padStart(2,'0')}:00</div>
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">{t('sess.weather')}</label>
                  <select className="select" value={sessionCfg.weather} onChange={e => set('weather', e.target.value)} disabled={!canEdit}>
                    <option value="3_clear">{t('sess.weather.clear')}</option>
                    <option value="4_mid_clear">{t('sess.weather.mid_clear')}</option>
                    <option value="5_light_clouds">{t('sess.weather.light_clouds')}</option>
                    <option value="6_mid_clouds">{t('sess.weather.mid_clouds')}</option>
                    <option value="7_heavy_clouds">{t('sess.weather.heavy_clouds')}</option>
                    <option value="2_light_fog">{t('sess.weather.light_fog')}</option>
                    <option value="1_heavy_fog">{t('sess.weather.heavy_fog')}</option>
                  </select>
                </div>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label">{t('sess.temp')}: {sessionCfg.airTemp}°C</label>
                  <input type="range" min="0" max="40" value={sessionCfg.airTemp} onChange={e => set('airTemp', Number(e.target.value))} disabled={!canEdit} style={{accentColor: 'var(--red)'}}/>
                </div>
                <div className="field">
                  <label className="field-label">{t('sess.penalties')}</label>
                  <div className="row" style={{gap: 10, alignItems:'center', minHeight: 24}}>
                    {window.AppShell.Switch ? (
                      <window.AppShell.Switch
                        on={sessionCfg.penalties}
                        disabled={!canEdit}
                        ariaLabel={t('sess.row.penalties') || 'Penalties'}
                        onChange={v => set('penalties', v)}
                      />
                    ) : (
                      <div className={`switch ${sessionCfg.penalties ? 'on' : ''}`} onClick={() => canEdit && set('penalties', !sessionCfg.penalties)}></div>
                    )}
                    <span className="muted" style={{fontSize: 12}}>{t('sess.penalties.hint')}</span>
                  </div>
                </div>
              </div>
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
                  <select className="select" value={sessionCfg.layout} onChange={e => set('layout', e.target.value)} disabled={!canEdit}>
                    {track.layouts.map(l => (
                      <option key={l} value={l}>
                        {(window.AppUtils?.layoutShortName?.(track, l)) || track.layoutDetails?.[l]?.name || l || 'Default'}
                      </option>
                    ))}
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
              <span className="badge right">{slots.length} slots</span>
            </div>
            <div style={{maxHeight: 220, overflowY: 'auto'}}>
              {slotCars.length === 0 ? (
                <div className="empty" style={{padding: '28px 20px'}}>
                  {t('sess.no_cars')}
                </div>
              ) : slotCars.map(({idx, slot, car: c}) => {
                // One row per slot — same car appearing twice with different
                // skins shows up as two distinct rows.
                const chosenSkin = slot.skin;
                const thumbSrc   = chosenSkin
                  ? `/api/content/cars/${encodeURIComponent(c.id)}/skins/${encodeURIComponent(chosenSkin)}/preview`
                  : c.thumb;
                return (
                <div key={idx} style={{display:'flex', alignItems:'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--border)'}}>
                  <div className="muted mono" style={{fontSize: 10, width: 22, textAlign:'right', flexShrink:0}}>{idx + 1}</div>
                  <div style={{width: 36, height: 22, borderRadius: 3, overflow:'hidden', background: 'var(--bg-3)', flexShrink: 0}}>
                    {thumbSrc && <img src={thumbSrc} style={{width:'100%', height:'100%', objectFit:'cover'}}
                      onError={e => { e.target.style.display='none'; }}/>}
                  </div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div style={{fontSize: 12.5, fontWeight: 500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{c.name}</div>
                    <div className="muted" style={{fontSize: 11, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
                      {chosenSkin
                        ? <>{c.brand} · <span style={{color:'var(--text)'}}>{t('sess.skin')}: {chosenSkin}</span></>
                        : c.brand}
                    </div>
                  </div>
                  <button className="icon-btn" style={{width: 24, height: 24}}
                    onClick={() => setSessionCfg(s => ({...s, slots: (s.slots || []).filter((_, i) => i !== idx)}))}>
                    <I3S.IconX size={12}/>
                  </button>
                </div>
                );
              })}
            </div>
          </div>

          {canEdit && (
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
