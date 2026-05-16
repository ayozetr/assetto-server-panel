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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
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
  const toast = window.AppShell ? window.AppShell.useToast() : { push: () => {} };
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
              <th>{t('pl.col.driver')}</th>
              <th>{t('pl.col.car')}</th>
              <th style={{width: 80}}>{t('pl.col.sessions')}</th>
              <th style={{width: 80}}>{t('pl.col.laps')}</th>
              <th style={{width: 110}}>{t('pl.col.best_lap')}</th>
              <th style={{width: 100}}>{t('pl.col.time')}</th>
              <th style={{width: 160}}>{t('pl.hist_col.date')}</th>
              {canModerate && <th style={{width: 80}}></th>}
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
                        {p.steam && (
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
                {canModerate && (
                  <td>
                    <button
                      className="icon-btn"
                      title={t('pl.nick.edit_tip')}
                      onClick={() => setEditingNick(p)}
                      style={{width: 26, height: 26}}
                    >
                      <I2P.IconEdit size={12}/>
                    </button>
                  </td>
                )}
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
                    {p.steam && (
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
      {modalNode}
      {confirmKick && ConfirmModal && (
        <ConfirmModal
          title={t('pl.kick')}
          message={`${t('pl.kick_confirm') || 'Kick'} ${confirmKick.name}?`}
          onCancel={() => setConfirmKick(null)}
          onConfirm={() => { const p = confirmKick; setConfirmKick(null); onKick(p); }}
        />
      )}
      {confirmBan && ConfirmModal && (
        <ConfirmModal
          title={t('pl.ban')}
          message={`${t('pl.ban_confirm') || 'Permanently ban'} ${confirmBan.name}?`}
          onCancel={() => setConfirmBan(null)}
          onConfirm={() => { const p = confirmBan; setConfirmBan(null); onBan(p); }}
        />
      )}
    </>
  );
}

window.AppPagesMonitoring = window.AppPagesMonitoring || {};
window.AppPagesMonitoring.PagePlayers = PagePlayers;
