// Page: Players (online + history). Split out of monitoring.jsx for size; the
// dashboard, players and logs sub-pages used to share one 585-line file. The
// `PagePlayers` symbol is published into `window.AppPagesMonitoring` along
// with the dashboard and logs counterparts so the consumer in app.jsx still
// destructures a single namespace.
const { useState: usePlayersState, useEffect: usePlayersEffect, useMemo: usePlayersMemo } = React;
const I2P = window.AppIcons;
const fmtMs = window.AppUtils.fmtMs;

// Render "Apodo (in-game name)" when an admin has set a nickname for this
// player, otherwise just the in-game name.
function renderPlayerName(name, nickname) {
  if (nickname) return `${nickname} (${name})`;
  return name;
}

function NicknameModal({ player, onSave, onClose }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [value, setValue] = usePlayersState(player.nickname || '');
  const submit = () => onSave(value.trim().slice(0, 64));
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const trapRef = window.AppShell.useFocusTrap ? window.AppShell.useFocusTrap(true) : { current: null };
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={trapRef} className="modal" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('pl.nick.title')} tabIndex={-1}>
        <div className="modal-header">
          <I2P.IconEdit size={15}/>
          <div className="modal-title">{t('pl.nick.title')}</div>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">{t('pl.nick.in_game')}</label>
            <div className="mono" style={{fontSize: 13}}>{player.name}</div>
          </div>
          <div className="field">
            <label className="field-label">{t('pl.nick.label')}</label>
            <input
              className="input"
              value={value}
              autoFocus
              maxLength={64}
              placeholder={t('pl.nick.placeholder')}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            />
            <span className="field-hint">{t('pl.nick.hint')}</span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={submit}>
            <I2P.IconCheck size={13}/> {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PagePlayers({ players: initialPlayers, pastPlayers, setPastPlayers, server, isAdmin, canModerate = isAdmin, canWhitelist = isAdmin, onKick, onBan }) {
  const showLiveActions = canModerate || canWhitelist;
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell.useToast();
  const ConfirmModal = window.AppPagesSettings && window.AppPagesSettings.ConfirmModal;
  const [players, setPlayers] = usePlayersState(initialPlayers);
  const [historySearch, setHistorySearch] = usePlayersState('');
  const [whitelisting, setWhitelisting] = usePlayersState({}); // guid → boolean
  // Both kick and ban are destructive (ban especially — it writes a
  // permanent line to blacklist.txt). Stash the pending player on a
  // "pending confirmation" state and surface a ConfirmModal before
  // forwarding to the parent's onKick/onBan. Previously clicking either
  // button fired the action immediately with no chance to back out.
  const [confirmKick, setConfirmKick] = usePlayersState(null);
  const [confirmBan,  setConfirmBan]  = usePlayersState(null);
  const [editingNick, setEditingNick] = usePlayersState(null); // past-player row

  // Look up nicknames by GUID so the live online table can render the same
  // "Apodo (in-game)" treatment without an extra backend call.
  const nickByGuid = usePlayersMemo(() => {
    const m = {};
    for (const p of pastPlayers || []) {
      if (p.steam && p.nickname) m[p.steam] = p.nickname;
    }
    return m;
  }, [pastPlayers]);

  // Public-profile share: prefer the modern async clipboard, fall back to a
  // temporary textarea + execCommand so the button keeps working in non-HTTPS
  // dev contexts (clipboard API requires a secure context). Always opens the
  // page in a new tab so the share-button second-clicks to "preview the
  // public view" without disrupting the panel session.
  const sharePublicProfile = async (player) => {
    if (!player.steam) {
      toast.push(t('pl.no_guid') || 'Player has no Steam GUID', 'warn');
      return;
    }
    const url = `${window.location.origin}/p/${player.steam}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand returned false');
      }
      toast.push(t('pl.share_copied'), 'success');
    } catch (e) {
      toast.push(t('pl.share_copy_fail') || `${t('common.error')}: ${e.message}`, 'error');
    }
  };

  const saveNickname = async (nickname) => {
    if (!editingNick) return;
    try {
      const r = await fetch(`/api/players/${encodeURIComponent(editingNick.steam)}/nickname`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        toast.push(`${t('common.error')}: ${d.error || ('HTTP ' + r.status)}`, 'error');
        return;
      }
      // Update local row so the table reflects the change without a full reload
      if (setPastPlayers) {
        setPastPlayers(prev => prev.map(p => p.id === editingNick.id ? { ...p, nickname } : p));
      }
      toast.push(t('pl.nick.saved'), 'success');
      setEditingNick(null);
    } catch (e) {
      toast.push(`${t('common.error')}: ${e.message}`, 'error');
    }
  };

  const handleWhitelist = async (p) => {
    if (!p.steam) { toast.push(t('pl.no_guid') || 'Player has no Steam GUID', 'warn'); return; }
    setWhitelisting(prev => ({ ...prev, [p.steam]: true }));
    try {
      const r = await fetch('/api/whitelist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid: p.steam, name: p.name }),
      });
      const d = await r.json();
      if (d.ok) {
        if (d.alreadyPresent) toast.push(`${p.name} ${t('pl.wl_exists') || 'already in whitelist'}`, 'info');
        else toast.push(`${p.name} ${t('pl.wl_added') || 'added to whitelist'}`, 'success');
      } else {
        toast.push(`${t('common.error')}: ${d.error || 'failed'}`, 'error');
      }
    } catch (e) {
      toast.push(`${t('common.error')}: ${e.message}`, 'error');
    } finally {
      setWhitelisting(prev => ({ ...prev, [p.steam]: false }));
    }
  };
  usePlayersEffect(() => {
    if (server.status !== 'running') return;
    const load = () => {
      fetch('/api/players')
        .then(r => r.json())
        .then(d => {
          if (Array.isArray(d)) setPlayers(d);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [server.status]);

  const [page, setPage] = usePlayersState(1);
  usePlayersEffect(() => { setPage(1); }, [historySearch]);

  const filteredPast = historySearch
    ? pastPlayers.filter(p => p.name.toLowerCase().includes(historySearch.toLowerCase()))
    : pastPlayers;

  const PAGE_SIZE = 50;
  const totalPages = Math.max(1, Math.ceil(filteredPast.length / PAGE_SIZE));
  const paginatedPast = filteredPast.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const renderPast = (
    <div style={{marginTop: 20}}>
      <div className="card">
        <div className="card-header">
          <I2P.IconHistory size={14} style={{color:'var(--red)'}}/>
          <div className="card-title">{t('pl.history')}</div>
          <span className="badge">{filteredPast.length}</span>
          <div className="search right" style={{maxWidth:200}}>
            <I2P.IconSearch size={12} className="search-icon"/>
            <input className="input" placeholder="..." value={historySearch}
              onChange={e=>setHistorySearch(e.target.value)} style={{height:28,fontSize:12}}/>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('pl.col.driver')}</th>
              <th scope="col">{t('pl.col.car')}</th>
              <th scope="col" style={{width: 80}}>{t('pl.col.sessions')}</th>
              <th scope="col" style={{width: 80}}>{t('pl.col.laps')}</th>
              <th scope="col" style={{width: 110}}>{t('pl.col.best_lap')}</th>
              <th scope="col" style={{width: 100}}>{t('pl.col.time')}</th>
              <th scope="col" style={{width: 160}}>{t('pl.hist_col.date')}</th>
              {/* Actions column is always rendered — the share button is
                  visible to every panel user; the edit-nickname pencil is
                  layered on top only for moderators. Keeps the table header
                  stable across roles. */}
              <th scope="col" style={{width: canModerate ? 92 : 56}}></th>
            </tr>
          </thead>
          <tbody>
            {paginatedPast.map(p => {
              const flagUrl = (window.AppUtils || {}).nationFlag?.(p.nation);
              return (
              <tr key={p.id}>
                <td>
                  <div className="row" style={{gap: 10}}>
                    <div className="user-avatar" style={{width: 26, height: 26, fontSize: 11, background: 'var(--bg-3)', color: 'var(--text-muted)'}}>
                      {((p.nickname || p.name) || '?').slice(0,1).toUpperCase()}
                    </div>
                    <div>
                      <div className="row" style={{gap: 5, alignItems:'center'}}>
                        <span className="player-name">{renderPlayerName(p.name, p.nickname)}</span>
                        {flagUrl && <img src={flagUrl} alt={p.nation} title={p.nation} style={{height:9, width:'auto', borderRadius:1, opacity:0.75}} onError={e=>{e.target.style.display='none'}}/>}
                      </div>
                      <div className="row" style={{gap:4, alignItems:'center', marginTop:2}}>
                        <div className="mono" style={{fontSize: 10.5, color: 'var(--text-faint)'}}>{p.steam}</div>
                        {/^\d{17}$/.test(p.steam) && (
                          <a href={`https://steamcommunity.com/profiles/${p.steam}`} target="_blank" rel="noreferrer"
                            style={{display:'flex', alignItems:'center', color:'var(--text-faint)', opacity:0.7, lineHeight:1}}
                            title="Steam">
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
                <td>
                  <div className="row" style={{gap: 4}}>
                    <button
                      className="icon-btn"
                      title={t('pl.share_tip')}
                      aria-label={t('pl.share_tip')}
                      onClick={() => sharePublicProfile(p)}
                      disabled={!p.steam}
                      style={{width: 26, height: 26}}
                    >
                      <I2P.IconLink size={12}/>
                    </button>
                    {canModerate && (
                      <button
                        className="icon-btn"
                        title={t('pl.nick.edit_tip')}
                        aria-label={t('pl.nick.edit_tip')}
                        onClick={() => setEditingNick(p)}
                        style={{width: 26, height: 26}}
                      >
                        <I2P.IconEdit size={12}/>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {totalPages > 1 && (
          <div className="pagination">
            <button className="btn btn-sm" disabled={page === 1} onClick={()=>setPage(1)}>«</button>
            <button className="btn btn-sm" disabled={page === 1} onClick={()=>setPage(p=>p-1)}>‹</button>
            <span className="pagination-info">{t('times.page_of', { page, totalPages })}</span>
            <button className="btn btn-sm" disabled={page === totalPages} onClick={()=>setPage(p=>p+1)}>›</button>
            <button className="btn btn-sm" disabled={page === totalPages} onClick={()=>setPage(totalPages)}>»</button>
          </div>
        )}
      </div>
    </div>
  );

  const modalNode = editingNick
    ? <NicknameModal player={editingNick} onSave={saveNickname} onClose={() => setEditingNick(null)}/>
    : null;

  if (server.status !== 'running') {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">{t('pl.title')}</h1>
          <p className="page-sub">{t('pl.sub')}</p>
        </div>
        <div className="card">
          <div className="empty">{t('topbar.stopped')}</div>
        </div>
        {renderPast}
        {modalNode}
      </>
    );
  }
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('pl.title')}</h1>
        <p className="page-sub">{players.length} / {server.slots}</p>
      </div>
      <div className="card">
        <div className="card-header">
          <I2P.IconPlayers size={14} style={{color:'var(--red)'}}/>
          <div className="card-title">{t('pl.online', {count: players.length})}</div>
          <span className="badge badge-green right">{players.length}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{width: 40}}>#</th>
              <th>{t('pl.col.driver')}</th>
              <th>{t('pl.col.car')}</th>
              <th style={{width: 80}}>{t('pl.col.laps')}</th>
              <th style={{width: 110}}>{t('pl.col.best')}</th>
              <th style={{width: 110}}>{t('pl.col.last')}</th>
              <th style={{width: 70}}>{t('pl.col.ping')}</th>
              {showLiveActions && <th style={{width: 140}}></th>}
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => (
              <tr key={p.id}>
                <td><div className={`player-pos ${i === 0 ? 'p1' : ''}`}>{i + 1}</div></td>
                <td>
                  <div className="row" style={{gap:5, alignItems:'center'}}>
                    <span className="player-name">{renderPlayerName(p.name, nickByGuid[p.steam])}</span>
                    {p.nation && (() => { const f = (window.AppUtils || {}).nationFlag?.(p.nation); return f ? <img src={f} alt={p.nation} title={p.nation} style={{height:9,width:'auto',borderRadius:1,opacity:0.75}} onError={e=>{e.target.style.display='none'}}/> : null; })()}
                  </div>
                  <div className="row" style={{gap: 4, alignItems:'center', marginTop:2}}>
                    <div className="mono" style={{fontSize: 10.5, color: 'var(--text-faint)'}}>{p.steam}</div>
                    {/^\d{17}$/.test(p.steam) && (
                      <a href={`https://steamcommunity.com/profiles/${p.steam}`} target="_blank" rel="noreferrer"
                        style={{display:'flex', alignItems:'center', color:'var(--text-faint)', opacity:0.7, lineHeight:1}}
                        title="Steam">
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
                {showLiveActions && (
                  <td>
                    <div className="row" style={{gap: 4}}>
                      {canWhitelist && (
                        <button
                          className="btn btn-sm"
                          onClick={() => handleWhitelist(p)}
                          disabled={!p.steam || whitelisting[p.steam]}
                          title={t('pl.wl_tip') || 'Add to whitelist'}
                        >
                          <I2P.IconShield size={12}/> {t('pl.wl') || 'Whitelist'}
                        </button>
                      )}
                      {canModerate && (
                        <>
                          <button className="btn btn-sm" onClick={() => setConfirmKick(p)}>
                            <I2P.IconKick size={12}/> {t('pl.kick')}
                          </button>
                          <button className="btn btn-sm btn-danger" onClick={() => setConfirmBan(p)}>
                            {t('pl.ban')}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {renderPast}
      {canModerate && <BansSection t={t} toast={toast}/>}
      {modalNode}
      {confirmKick && ConfirmModal && (
        <ConfirmModal
          title={t('pl.kick')}
          message={`${t('pl.kick_confirm') || 'Kick'} ${confirmKick.name}?`}
          onCancel={() => setConfirmKick(null)}
          onConfirm={() => { const p = confirmKick; setConfirmKick(null); onKick(p); }}
        />
      )}
      {confirmBan && (
        <BanModal
          player={confirmBan}
          onCancel={() => setConfirmBan(null)}
          onSubmit={({ reason, durationDays }) => {
            const p = confirmBan;
            setConfirmBan(null);
            onBan(p, { reason, durationDays });
          }}
          t={t}
        />
      )}
    </>
  );
}

// Ban modal — gathers an optional reason and a duration (permanent or N days)
// before forwarding to the parent's onBan. The reason ends up in the bans
// table and in the audit log; the duration drives the TTL sweeper that lifts
// the ban automatically on expiry.
function BanModal({ player, onCancel, onSubmit, t }) {
  const [reason,   setReason]   = usePlayersState('');
  const [preset,   setPreset]   = usePlayersState('permanent');
  const [custom,   setCustom]   = usePlayersState(7);
  const trapRef = window.AppShell.useFocusTrap ? window.AppShell.useFocusTrap(true) : { current: null };
  usePlayersEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  const submit = (e) => {
    e?.preventDefault();
    const durationDays = preset === 'permanent' ? 0
                       : preset === 'custom'    ? Math.max(1, Math.min(36500, parseInt(custom, 10) || 1))
                       :                          parseInt(preset, 10);
    onSubmit({ reason: reason.trim(), durationDays });
  };
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div ref={trapRef} className="modal" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('pl.ban') || 'Ban player'} tabIndex={-1}>
        <form className="modal-form" onSubmit={submit}>
          <div className="modal-header">
            <I2P.IconShield size={15} style={{color:'var(--red)'}}/>
            <div className="modal-title">{t('pl.ban') || 'Ban player'}</div>
          </div>
          <div className="modal-body col" style={{gap: 12}}>
            <div className="field">
              <label className="field-label">{t('pl.ban_player') || 'Player'}</label>
              <div className="input mono" style={{padding:'7px 10px', background:'var(--bg-3)', fontSize:12.5}}>
                {player.name} <span className="muted" style={{marginLeft:6}}>{player.steam}</span>
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t('pl.ban_reason') || 'Reason'} <span className="muted" style={{fontWeight:'normal'}}>({t('common.optional') || 'optional'})</span></label>
              <input className="input"
                value={reason}
                onChange={e => setReason(e.target.value.slice(0, 240))}
                maxLength={240}
                placeholder={t('pl.ban_reason_placeholder') || 'e.g. ramming, cheating, racial slurs in chat'}
                autoFocus/>
              <span className="field-hint">{t('pl.ban_reason_hint') || 'Up to 240 characters. Visible to other admins in the bans list and audit log.'}</span>
            </div>
            <div className="field">
              <label className="field-label">{t('pl.ban_duration') || 'Duration'}</label>
              <div className="row" style={{gap: 6, flexWrap: 'wrap'}}>
                {[
                  ['permanent', t('pl.ban_perm') || 'Permanent'],
                  ['1',         t('pl.ban_1d')   || '1 day'],
                  ['7',         t('pl.ban_7d')   || '7 days'],
                  ['30',        t('pl.ban_30d')  || '30 days'],
                  ['custom',    t('pl.ban_custom') || 'Custom'],
                ].map(([k, label]) => (
                  <button key={k} type="button"
                    className={`btn btn-sm ${preset === k ? 'btn-primary' : ''}`}
                    onClick={() => setPreset(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {preset === 'custom' && (
                <div className="row" style={{gap: 6, alignItems: 'center', marginTop: 8}}>
                  <input className="input" type="number" inputMode="numeric" min="1" max="36500"
                    style={{maxWidth: 100}}
                    value={custom}
                    onChange={e => setCustom(e.target.value)}/>
                  <span className="muted" style={{fontSize: 12.5}}>{t('pl.ban_days') || 'days'}</span>
                </div>
              )}
              <span className="field-hint">{t('pl.ban_duration_hint') || 'Temporary bans are lifted automatically when they expire; the audit log keeps the record.'}</span>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-danger">
              <I2P.IconShield size={13}/> {t('pl.ban') || 'Ban'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Active bans section ──────────────────────────────────────────────────────
// Renders /api/bans as a compact table at the bottom of the Players page so
// admins with playerModeration can see who is currently banned, why, until
// when, and lift a ban with one click. Auto-refreshes when the page comes
// back into focus; otherwise stays cached for cheapness.
function BansSection({ t, toast }) {
  const [bans, setBans] = usePlayersState([]);
  const [loaded, setLoaded] = usePlayersState(false);
  const [busy, setBusy] = usePlayersState({}); // guid → bool while unban request is in flight
  const load = () => fetch('/api/bans')
    .then(r => r.json())
    .then(d => { if (Array.isArray(d)) setBans(d); })
    .catch(() => {})
    .finally(() => setLoaded(true));
  usePlayersEffect(() => { load(); }, []);
  // Re-poll when the tab becomes visible — the sweeper unbans on a 1h cadence
  // server-side, so a stale list quickly drifts. Cheap to refresh.
  usePlayersEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const unban = async (b) => {
    if (busy[b.guid]) return;
    setBusy(s => ({ ...s, [b.guid]: true }));
    try {
      const r = await fetch(`/api/players/${encodeURIComponent(b.guid)}/ban`, { method: 'DELETE' });
      const d = await r.json();
      if (d.ok) {
        setBans(prev => prev.filter(x => x.guid !== b.guid));
        toast.push(`${b.name || b.guid} ${t('pl.bans_unbanned') || 'unbanned'}`, 'success');
      } else {
        toast.push(d.error || t('common.error'), 'error');
      }
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setBusy(s => { const n = { ...s }; delete n[b.guid]; return n; }); }
  };

  if (!loaded) return null;
  if (!bans.length) {
    return (
      <div className="card" style={{marginTop: 16}}>
        <div className="card-header">
          <I2P.IconShield size={14}/>
          <div className="card-title">{t('pl.bans_title') || 'Active bans'}</div>
          <span className="badge" style={{marginLeft: 'auto'}}>0</span>
        </div>
        <div className="card-body">
          <div className="muted" style={{fontSize: 12.5, padding: '8px 4px'}}>
            {t('pl.bans_empty') || 'No active bans.'}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="card" style={{marginTop: 16}}>
      <div className="card-header">
        <I2P.IconShield size={14}/>
        <div className="card-title">{t('pl.bans_title') || 'Active bans'}</div>
        <span className="badge" style={{marginLeft: 'auto'}}>{bans.length}</span>
      </div>
      <div style={{overflowX: 'auto'}}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('pl.bans_col_player')   || 'Player'}</th>
              <th>{t('pl.bans_col_reason')   || 'Reason'}</th>
              <th>{t('pl.bans_col_by')       || 'Banned by'}</th>
              <th>{t('pl.bans_col_when')     || 'Banned at'}</th>
              <th>{t('pl.bans_col_expires')  || 'Expires'}</th>
              <th style={{width: 90}}></th>
            </tr>
          </thead>
          <tbody>
            {bans.map(b => (
              <tr key={b.guid}>
                <td>
                  <div className="player-name">{b.name || b.guid}</div>
                  <div className="mono muted" style={{fontSize: 10.5}}>{b.guid}</div>
                </td>
                <td className="muted" style={{fontSize: 12.5, maxWidth: 280}}>
                  {b.reason || <span style={{fontStyle:'italic', color:'var(--text-faint)'}}>—</span>}
                </td>
                <td className="muted" style={{fontSize: 12.5}}>{b.bannedBy || '—'}</td>
                <td className="muted" style={{fontSize: 12, whiteSpace: 'nowrap'}}>{b.bannedAt || '—'}</td>
                <td className="muted" style={{fontSize: 12, whiteSpace: 'nowrap'}}>
                  {b.permanent
                    ? <span className="badge" style={{background:'color-mix(in srgb, var(--red) 14%, transparent)', color:'var(--red)'}}>{t('pl.ban_perm') || 'Permanent'}</span>
                    : <span style={b.expired ? {color:'var(--text-faint)'} : {}}>{b.expiresAt}</span>}
                </td>
                <td>
                  <button className="btn btn-sm" disabled={!!busy[b.guid]} onClick={() => unban(b)}>
                    {busy[b.guid] ? '…' : (t('pl.bans_unban') || 'Unban')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

window.AppPagesMonitoring = window.AppPagesMonitoring || {};
window.AppPagesMonitoring.PagePlayers = PagePlayers;
