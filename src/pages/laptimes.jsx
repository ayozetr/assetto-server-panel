// Page: Tiempos (lap-time database with filters & comparisons)
const { useState: uSt, useMemo: uMt, useEffect: uEt } = React;
const ITi = window.AppIcons;

const fmtMs = window.AppUtils.fmtMs;
const fmtDelta = (ms) => {
  if (ms == null) return '—';
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  return sign + fmtMs(Math.abs(ms)).replace(/^0:/, '');
};

const PAGE_SIZE         = 50; // records view (best lap per driver+track)
const PAGE_SIZE_ALL     = 10; // every-lap view — smaller because it lists raw rows

// Parse a user-entered lap time into milliseconds. Accepts either pure ms
// (e.g. "92456") or the canonical "m:ss.mmm" format that fmtMs produces, with
// optional 1- or 2-digit minutes and 1-3 digit ms. Returns NaN on malformed
// input so the modal can flag it.
function parseLapTimeInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const mins  = parseInt(m[1], 10);
  const secs  = parseInt(m[2], 10);
  const msStr = (m[3] || '0').padEnd(3, '0').slice(0, 3);
  const ms    = parseInt(msStr, 10);
  if (secs >= 60) return NaN;
  return mins * 60_000 + secs * 1000 + ms;
}

function AddLapModal({ cars, tracks, pastPlayers, onSave, onClose }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  // Past players come from /api/players/history — admin picks one from the
  // dropdown instead of typing name + GUID. The "__custom__" sentinel keeps
  // the manual-entry escape hatch for brand-new pilots that have never
  // joined the server.
  const sortedPlayers = uMt(() => {
    const seen = new Set();
    const out = [];
    for (const p of (pastPlayers || [])) {
      const guid = p.steam || p.id;
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      out.push({
        guid,
        name:     p.name || guid,
        nickname: p.nickname || '',
      });
    }
    out.sort((a, b) => {
      const la = (a.nickname || a.name).toLowerCase();
      const lb = (b.nickname || b.name).toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    return out;
  }, [pastPlayers]);

  const [driverGuidSel, setDriverGuidSel] = uSt(sortedPlayers[0]?.guid || '__custom__');
  const [customName,    setCustomName]    = uSt('');
  const [customGuid,    setCustomGuid]    = uSt('');
  const isCustom = driverGuidSel === '__custom__' || sortedPlayers.length === 0;

  const [trackId,    setTrackId]    = uSt(tracks[0]?.id || '');
  const [layout,     setLayout]     = uSt('');
  const [carId,      setCarId]      = uSt(cars[0]?.id || '');
  const [timeStr,    setTimeStr]    = uSt('');
  const [s1Str,      setS1Str]      = uSt('');
  const [s2Str,      setS2Str]      = uSt('');
  const [s3Str,      setS3Str]      = uSt('');
  const [valid,      setValid]      = uSt(true);
  const [date,       setDate]       = uSt(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = uSt(false);
  const [error,      setError]      = uSt('');

  const selectedTrack = uMt(() => tracks.find(t => t.id === trackId), [tracks, trackId]);
  const trackLayouts  = uMt(() => {
    const ls = selectedTrack?.layouts;
    if (!Array.isArray(ls)) return [];
    return ls.filter(l => l && l !== '');
  }, [selectedTrack]);

  // Reset layout when the track changes so a stale value from the previous
  // track can't sneak into the payload.
  uEt(() => { setLayout(''); }, [trackId]);

  const submit = async () => {
    setError('');
    let driverName, driverGuid;
    if (isCustom) {
      driverName = customName.trim();
      driverGuid = customGuid.trim();
      if (!driverName) { setError(t('times.add.driver')); return; }
    } else {
      const p = sortedPlayers.find(x => x.guid === driverGuidSel);
      if (!p) { setError(t('times.add.driver')); return; }
      driverName = p.name;
      driverGuid = p.guid;
    }
    if (!carId)   { setError(t('times.add.car'));   return; }
    if (!trackId) { setError(t('times.add.track')); return; }
    const ms = parseLapTimeInput(timeStr);
    if (!Number.isFinite(ms) || ms <= 0) { setError(t('times.add.err_time')); return; }
    const s1 = s1Str ? parseLapTimeInput(s1Str) : 0;
    const s2 = s2Str ? parseLapTimeInput(s2Str) : 0;
    const s3 = s3Str ? parseLapTimeInput(s3Str) : 0;

    setSubmitting(true);
    try {
      const r = await fetch('/api/laps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driver_name:  driverName,
          driver_guid:  driverGuid,
          car:          carId,
          track:        trackId,
          track_config: layout,
          ms,
          s1: Number.isFinite(s1) ? s1 : 0,
          s2: Number.isFinite(s2) ? s2 : 0,
          s3: Number.isFinite(s3) ? s3 : 0,
          valid,
          session_date: date,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 409) setError(t('times.add.err_dup'));
        else setError(data.error || t('times.add.err_generic'));
        setSubmitting(false);
        return;
      }
      onSave();
    } catch (e) {
      setError(t('times.add.err_generic'));
      setSubmitting(false);
    }
  };

  const trapRef = window.AppShell.useFocusTrap ? window.AppShell.useFocusTrap(true) : { current: null };
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={trapRef} className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth: 560}} role="dialog" aria-modal="true" aria-label={t('times.add.title')} tabIndex={-1}>
        <div className="modal-header">
          <ITi.IconTimer size={15}/>
          <div className="modal-title">{t('times.add.title')}</div>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">{t('times.add.driver')}</label>
            <select
              className="select" autoFocus
              value={driverGuidSel} onChange={e=>setDriverGuidSel(e.target.value)}
            >
              {sortedPlayers.map(p => (
                <option key={p.guid} value={p.guid}>
                  {p.nickname ? `${p.nickname} (${p.name})` : p.name}
                </option>
              ))}
              <option value="__custom__">{t('times.add.driver_custom')}</option>
            </select>
            <span className="field-hint">
              {sortedPlayers.length === 0 ? t('times.add.no_players') : t('times.add.driver_hint')}
            </span>
          </div>

          {isCustom && (
            <>
              <div className="field">
                <label className="field-label">{t('times.add.custom_name')}</label>
                <input
                  className="input" maxLength={64}
                  value={customName} onChange={e=>setCustomName(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label">{t('times.add.guid')}</label>
                <input
                  className="input mono" maxLength={64} placeholder="76561198…"
                  value={customGuid} onChange={e=>setCustomGuid(e.target.value)}
                />
                <span className="field-hint">{t('times.add.guid_hint')}</span>
              </div>
            </>
          )}

          <div className="row" style={{gap: 8, flexWrap: 'wrap'}}>
            <div className="field" style={{flex: '1 1 220px', minWidth: 200}}>
              <label className="field-label">{t('times.add.track')}</label>
              <select className="select" value={trackId} onChange={e=>setTrackId(e.target.value)}>
                {tracks.map(tr => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
              </select>
            </div>
            {trackLayouts.length > 0 && (
              <div className="field" style={{flex: '1 1 160px', minWidth: 160}}>
                <label className="field-label">{t('times.add.layout')}</label>
                <select className="select" value={layout} onChange={e=>setLayout(e.target.value)}>
                  <option value="">{t('times.add.layout_none')}</option>
                  {trackLayouts.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="field">
            <label className="field-label">{t('times.add.car')}</label>
            <select className="select" value={carId} onChange={e=>setCarId(e.target.value)}>
              {cars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div className="field">
            <label className="field-label">{t('times.add.time')}</label>
            <input
              className="input mono" placeholder="1:32.456"
              value={timeStr} onChange={e=>setTimeStr(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !submitting) submit(); }}
            />
            <span className="field-hint">{t('times.add.time_hint')}</span>
          </div>

          <div className="field">
            <label className="field-label">{t('times.add.sectors')}</label>
            <div className="row" style={{gap: 6}}>
              <input className="input mono" style={{flex: 1}} placeholder="S1" value={s1Str} onChange={e=>setS1Str(e.target.value)}/>
              <input className="input mono" style={{flex: 1}} placeholder="S2" value={s2Str} onChange={e=>setS2Str(e.target.value)}/>
              <input className="input mono" style={{flex: 1}} placeholder="S3" value={s3Str} onChange={e=>setS3Str(e.target.value)}/>
            </div>
          </div>

          <div className="row" style={{gap: 12, flexWrap: 'wrap', alignItems: 'flex-end'}}>
            <div className="field" style={{flex: '1 1 180px'}}>
              <label className="field-label">{t('times.add.date')}</label>
              <input type="date" className="input" value={date} onChange={e=>setDate(e.target.value)}/>
            </div>
            <label className="row" style={{gap: 6, fontSize: 13, cursor:'pointer', paddingBottom: 6}}>
              <input type="checkbox" className={`checkbox ${valid ? 'on' : ''}`} checked={valid} onChange={()=>setValid(v=>!v)} />
              {t('times.add.valid')}
            </label>
          </div>

          {error && (
            <div style={{color: 'var(--red)', fontSize: 12, marginTop: 8}}>{error}</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={submitting}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            <ITi.IconCheck size={13}/> {submitting ? '…' : t('times.add.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PageTimes({ cars, tracks, lapTimes, lapTimesLoaded, pastPlayers, isAdmin, onLapAdded }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [trackId,  setTrackId]  = uSt('all');
  const [carId,    setCarId]    = uSt('all');
  const [validOnly, setValidOnly] = uSt(true);
  const [dateFrom, setDateFrom] = uSt('');
  const [dateTo,   setDateTo]   = uSt('');
  const [view,     setView]     = uSt('records'); // records | all | compare
  const [page,     setPage]     = uSt(1);
  const [selectedPlayers, setSelectedPlayers] = uSt([]);
  const [showAddModal, setShowAddModal] = uSt(false);
  const toast = window.AppShell.useToast();

  // Reset to page 1 whenever filters or view change
  uEt(() => { setPage(1); }, [trackId, carId, validOnly, dateFrom, dateTo, view]);

  const allPlayers = uMt(() => Array.from(new Set(lapTimes.map(l => l.player))).sort(), [lapTimes]);
  // Build a single map for nickname lookup so the comparison view, tag chips
  // and header all use the same "Apodo (in-game)" treatment as the records table.
  const nickByPlayer = uMt(() => {
    const m = {};
    for (const l of lapTimes) { if (l.nickname && !m[l.player]) m[l.player] = l.nickname; }
    return m;
  }, [lapTimes]);
  const labelOf = (p) => nickByPlayer[p] ? `${nickByPlayer[p]} (${p})` : p;

  // Only show tracks/cars that have at least one lap time
  const usedTrackIds   = uMt(() => new Set(lapTimes.map(l => l.track)), [lapTimes]);
  const usedCarIds     = uMt(() => new Set(lapTimes.map(l => l.car)),   [lapTimes]);
  const tracksWithData = uMt(() => tracks.filter(t => usedTrackIds.has(t.id)), [tracks, usedTrackIds]);
  const carsWithData   = uMt(() => cars.filter(c => usedCarIds.has(c.id)),     [cars,   usedCarIds]);

  const filtered = uMt(() => lapTimes.filter(l => {
    if (trackId !== 'all' && l.track !== trackId) return false;
    if (carId   !== 'all' && l.car   !== carId)   return false;
    if (validOnly && !l.valid)                     return false;
    if (dateFrom && l.date < dateFrom)             return false;
    if (dateTo   && l.date > dateTo)               return false;
    return true;
  }), [lapTimes, trackId, carId, validOnly, dateFrom, dateTo]);

  // Best lap per (player, track) for the records view
  const records = uMt(() => {
    const map = new Map();
    for (const l of filtered) {
      const key = `${l.player}|${l.track}`;
      const prev = map.get(key);
      if (!prev || l.ms < prev.ms) map.set(key, l);
    }
    return Array.from(map.values()).sort((a,b) => a.ms - b.ms);
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const paginated  = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Lookup table for the per-track best lap. Without this, the records-view
  // delta column did records.find(...) per row per render — O(rows × records)
  // each render, ~500k iterations for 50 rows × 10k records.
  const bestPerTrack = uMt(() => {
    const m = new Map();
    for (const r of records) {
      const prev = m.get(r.track);
      if (!prev || r.ms < prev.ms) m.set(r.track, r);
    }
    return m;
  }, [records]);

  // Every-lap view (no dedupe). Sorted fastest-first so the leaderboard read
  // matches the records view; pagination 10 per page since the table can be
  // hundreds of rows on a busy server.
  const allLaps      = uMt(() => filtered.slice().sort((a, b) => a.ms - b.ms), [filtered]);
  const totalPagesAll = Math.max(1, Math.ceil(allLaps.length / PAGE_SIZE_ALL));
  const paginatedAll  = allLaps.slice((page - 1) * PAGE_SIZE_ALL, page * PAGE_SIZE_ALL);

  const trackName = (id) => tracks.find(t => t.id === id)?.name || id;
  const carName   = (id) => cars.find(c => c.id === id)?.name   || id;

  const togglePlayer = (p) => setSelectedPlayers(s =>
    s.includes(p) ? s.filter(x => x !== p) : (s.length >= 4 ? s : [...s, p])
  );

  // Proper RFC 4180 CSV escape — driver names with commas (`Lopez, José`),
  // quotes, or newlines used to corrupt the export and shift every later
  // column one cell to the right. Wrap any value that contains a `,`, `"`,
  // CR, or LF in double quotes and double-up internal quotes.
  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const exportCSV = () => {
    const header = [
      t('times.col.driver'), t('times.col.track'), t('times.col.car'),
      t('times.col.time'), 'S1', 'S2', 'S3', t('times.col.valid'), t('times.col.date')
    ].map(csvCell).join(',');
    const rows = records.map(r =>
      [r.player, trackName(r.track), carName(r.car), fmtMs(r.ms),
       fmtMs(r.s1), fmtMs(r.s2), fmtMs(r.s3), r.valid ? t('common.yes') : t('common.no'), r.date]
        .map(csvCell).join(',')
    );
    const blob = new Blob([[header, ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t('times.export.filename')||'laptimes'}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    // Free the blob URL — browsers can hold them until the tab closes
    // otherwise, leaking memory for every export.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('times.title')}</h1>
        <p className="page-sub">{t('times.sub')}</p>
      </div>

      <div className="toolbar">
        <div className="segmented">
          <button className={view === 'records' ? 'active' : ''} onClick={()=>setView('records')}>{t('times.tab.records')}</button>
          <button className={view === 'all'     ? 'active' : ''} onClick={()=>setView('all')}    >{t('times.tab.all')}</button>
          <button className={view === 'compare' ? 'active' : ''} onClick={()=>setView('compare')}>{t('times.tab.compare')}</button>
        </div>
        <div className="right row" style={{gap: 6}}>
          {isAdmin && (
            <button className="btn btn-sm btn-primary" onClick={()=>setShowAddModal(true)}>
              <ITi.IconPlus size={11}/> {t('times.add')}
            </button>
          )}
          <button className="btn btn-sm" onClick={exportCSV}>
            <ITi.IconDownload size={11}/> CSV
          </button>
        </div>

        {/* Track / car / validity filters */}
        <div className="row" style={{gap: 6, flexWrap:'wrap'}}>
          <select className="select" value={trackId} onChange={e=>setTrackId(e.target.value)} style={{width: 220}}>
            <option value="all">{t('times.all_tracks')}</option>
            {tracksWithData.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="select" value={carId} onChange={e=>setCarId(e.target.value)} style={{width: 200}}>
            <option value="all">{t('times.all_cars')}</option>
            {carsWithData.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="row" style={{gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor:'pointer'}}>
            <input type="checkbox" className={`checkbox ${validOnly ? 'on' : ''}`} checked={validOnly} onChange={()=>setValidOnly(v=>!v)} />
            {t('times.valid_only')}
          </label>
        </div>

        {/* Date range filter */}
        <div className="row" style={{gap: 6, flexWrap:'wrap', alignItems:'center'}}>
          <span style={{fontSize: 12, color: 'var(--text-muted)'}}>{t('times.date.from')}</span>
          <input
            type="date"
            className="input"
            style={{width: 150, fontSize: 12, padding: '4px 8px'}}
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
          />
          <span style={{fontSize: 12, color: 'var(--text-muted)'}}>{t('times.date.to')}</span>
          <input
            type="date"
            className="input"
            style={{width: 150, fontSize: 12, padding: '4px 8px'}}
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
          />
          {(dateFrom || dateTo) && (
            <button className="btn btn-sm" onClick={()=>{ setDateFrom(''); setDateTo(''); }} title={t('times.date.clear')}>
              <ITi.IconX size={11}/>
            </button>
          )}
        </div>

        <div className="right muted" style={{fontSize: 11.5}}>
          <span className="mono">{filtered.length}</span> {t('times.laps')} · <span className="mono">{records.length}</span> {t('times.records')}
        </div>
      </div>

      {view === 'records' && (
        <div className="card">
          <div className="card-header">
            <ITi.IconTimer size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('times.best_per_driver')}</div>
            {totalPages > 1 && (
              <span className="right muted" style={{fontSize: 11.5}}>
                {t('times.page')} {page}/{totalPages}
              </span>
            )}
          </div>
          {!lapTimesLoaded && lapTimes.length === 0 ? (
            <div className="loading-row">
              <div style={{width:18,height:18,borderRadius:'50%',border:'2px solid var(--border)',borderTopColor:'var(--red)',animation:'spin 0.8s linear infinite'}}></div>
              {t('common.loading')}
            </div>
          ) : records.length === 0 ? (
            <div className="empty">{t('common.not_found')}</div>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col" style={{width: 50}}>#</th>
                    <th scope="col">{t('times.col.driver')}</th>
                    <th scope="col">{t('times.col.track')}</th>
                    <th scope="col">{t('times.col.car')}</th>
                    <th scope="col" style={{width: 110}}>{t('times.col.best')}</th>
                    <th scope="col" style={{width: 90}}>S1</th>
                    <th scope="col" style={{width: 90}}>S2</th>
                    <th scope="col" style={{width: 90}}>S3</th>
                    <th scope="col" style={{width: 110}}>{t('times.col.delta')}</th>
                    <th scope="col" style={{width: 110}}>{t('times.col.date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((r, i) => {
                    const globalIndex = (page - 1) * PAGE_SIZE + i;
                    // bestPerTrack is built from the same records set so the
                    // lookup always finds a row; the fallback to r itself just
                    // belt-and-braces against a future refactor that decouples
                    // the two collections (delta would then be 0, not NaN).
                    const trackBest = bestPerTrack.get(r.track) || r;
                    const delta = r.ms - trackBest.ms;
                    return (
                      <tr key={r.id}>
                        <td><div className={`player-pos ${globalIndex === 0 ? 'p1' : ''}`}>{globalIndex + 1}</div></td>
                        <td className="player-name">{r.nickname ? `${r.nickname} (${r.player})` : r.player}</td>
                        <td className="muted">{trackName(r.track)}</td>
                        <td className="muted" style={{fontSize: 12}}>{carName(r.car)}</td>
                        <td className="mono" style={{fontWeight: 600}}>{fmtMs(r.ms)}</td>
                        <td className="mono muted">{fmtMs(r.s1)}</td>
                        <td className="mono muted">{fmtMs(r.s2)}</td>
                        <td className="mono muted">{fmtMs(r.s3)}</td>
                        <td className="mono" style={{color: delta === 0 ? '#16a34a' : 'var(--text-muted)', fontWeight: delta === 0 ? 600 : 400}}>
                          {delta === 0 ? '—' : fmtDelta(delta)}
                        </td>
                        <td className="mono muted" style={{fontSize: 12}}>{r.date}</td>
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
            </>
          )}
        </div>
      )}

      {view === 'all' && (
        <div className="card">
          <div className="card-header">
            <ITi.IconHistory size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('times.all_laps')}</div>
            {totalPagesAll > 1 && (
              <span className="right muted" style={{fontSize: 11.5}}>
                {t('times.page')} {page}/{totalPagesAll}
              </span>
            )}
          </div>
          {!lapTimesLoaded && lapTimes.length === 0 ? (
            <div className="loading-row">
              <div style={{width:18,height:18,borderRadius:'50%',border:'2px solid var(--border)',borderTopColor:'var(--red)',animation:'spin 0.8s linear infinite'}}></div>
              {t('common.loading')}
            </div>
          ) : allLaps.length === 0 ? (
            <div className="empty">{t('common.not_found')}</div>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{width: 50}}>#</th>
                    <th>{t('times.col.driver')}</th>
                    <th>{t('times.col.track')}</th>
                    <th>{t('times.col.car')}</th>
                    <th style={{width: 110}}>{t('times.col.time')}</th>
                    <th style={{width: 90}}>S1</th>
                    <th style={{width: 90}}>S2</th>
                    <th style={{width: 90}}>S3</th>
                    <th style={{width: 70}}>{t('times.col.valid')}</th>
                    <th style={{width: 110}}>{t('times.col.date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedAll.map((r, i) => {
                    const globalIndex = (page - 1) * PAGE_SIZE_ALL + i;
                    return (
                      <tr key={r.id}>
                        <td><div className={`player-pos ${globalIndex === 0 ? 'p1' : ''}`}>{globalIndex + 1}</div></td>
                        <td className="player-name">{r.nickname ? `${r.nickname} (${r.player})` : r.player}</td>
                        <td className="muted">{trackName(r.track)}</td>
                        <td className="muted" style={{fontSize: 12}}>{carName(r.car)}</td>
                        <td className="mono" style={{fontWeight: r.valid ? 600 : 400, color: r.valid ? undefined : 'var(--text-muted)'}}>{fmtMs(r.ms)}</td>
                        <td className="mono muted">{fmtMs(r.s1)}</td>
                        <td className="mono muted">{fmtMs(r.s2)}</td>
                        <td className="mono muted">{fmtMs(r.s3)}</td>
                        <td>
                          {r.valid
                            ? <span className="badge badge-green">{t('common.yes')}</span>
                            : <span className="badge badge-amber">{t('common.no')}</span>}
                        </td>
                        <td className="mono muted" style={{fontSize: 12}}>{r.date}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {totalPagesAll > 1 && (
                <div className="pagination">
                  <button className="btn btn-sm" disabled={page === 1} onClick={()=>setPage(1)}>«</button>
                  <button className="btn btn-sm" disabled={page === 1} onClick={()=>setPage(p=>p-1)}>‹</button>
                  <span className="pagination-info">{t('times.page_of', { page, totalPages: totalPagesAll })}</span>
                  <button className="btn btn-sm" disabled={page === totalPagesAll} onClick={()=>setPage(p=>p+1)}>›</button>
                  <button className="btn btn-sm" disabled={page === totalPagesAll} onClick={()=>setPage(totalPagesAll)}>»</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {view === 'compare' && (
        <>
          <div className="card" style={{marginBottom: 16}}>
            <div className="card-header">
              <div className="card-title">{t('times.compare.select')}</div>
              <span className="right muted" style={{fontSize: 11.5}}>{selectedPlayers.length} / 4</span>
            </div>
            <div className="card-body">
              <div className="tag-row">
                {allPlayers.map(p => (
                  <button key={p}
                    className={`tag ${selectedPlayers.includes(p) ? 'active' : ''}`}
                    onClick={()=>togglePlayer(p)}>
                    {labelOf(p)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <ComparisonTable
            players={selectedPlayers}
            labelOf={labelOf}
            tracks={tracks}
            laps={filtered}
            trackId={trackId}
            t={t}
          />
        </>
      )}

      {showAddModal && (
        <AddLapModal
          cars={cars}
          tracks={tracks}
          pastPlayers={pastPlayers}
          onSave={() => {
            setShowAddModal(false);
            toast.push(t('times.add.ok'), 'success');
            if (typeof onLapAdded === 'function') onLapAdded();
          }}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </>
  );
}

function ComparisonTable({ players, labelOf, tracks, laps, trackId, t }) {
  // Hooks must run before any early return, or the hook count changes between
  // renders (React #310) when the first/last driver is (de)selected.
  const bestMap = uMt(() => {
    const m = new Map();
    for (const l of laps) {
      const key = `${l.track}|${l.player}`;
      const cur = m.get(key);
      if (!cur || l.ms < cur.ms) m.set(key, l);
    }
    return m;
  }, [laps]);

  if (players.length < 1) {
    return (
      <div className="card"><div className="empty">{t('times.compare.empty_sel')}</div></div>
    );
  }
  const visibleTracks = trackId === 'all' ? tracks : tracks.filter(t => t.id === trackId);

  const rows = visibleTracks.map(t => {
    const cells = players.map(p => bestMap.get(`${t.id}|${p}`));
    const validMs = cells.filter(c => c).map(c => c.ms);
    const best = validMs.length ? Math.min(...validMs) : null;
    return { track: t, cells, best };
  }).filter(r => r.cells.some(c => c));

  if (rows.length === 0) return (
    <div className="card"><div className="empty">{t('times.compare.no_data')}</div></div>
  );

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">{t('times.compare.title')}</div>
        <span className="right muted" style={{fontSize: 11.5}}>{t('times.compare.tracks', { count: rows.length })}</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('times.col.track')}</th>
            {players.map(p => <th key={p} style={{width: 160}}>{labelOf ? labelOf(p) : p}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.track.id}>
              <td>
                <div className="row" style={{gap: 10}}>
                  <div style={{width: 40, height: 24, borderRadius: 3, overflow:'hidden', background:'var(--bg-3)', flexShrink: 0}}>
                    <img src={r.track.thumb} style={{width:'100%', height:'100%', objectFit:'cover'}}
                      onError={e => { e.target.style.display='none'; }}/>
                  </div>
                  <div>
                    <div style={{fontSize: 13, fontWeight: 500}}>{r.track.name}</div>
                    <div className="muted" style={{fontSize: 11}}>{r.track.length} km</div>
                  </div>
                </div>
              </td>
              {r.cells.map((c, i) => {
                if (!c) return <td key={i} className="muted">—</td>;
                const isBest = c.ms === r.best;
                const delta  = c.ms - r.best;
                return (
                  <td key={i}>
                    <div className="mono" style={{fontWeight: isBest ? 600 : 500, color: isBest ? 'var(--red)' : 'var(--text)'}}>
                      {fmtMs(c.ms)}
                    </div>
                    {!isBest && (
                      <div className="mono muted" style={{fontSize: 11}}>{fmtDelta(delta)}</div>
                    )}
                    {isBest && players.length > 1 && (
                      <div className="mono" style={{fontSize: 10.5, color: 'var(--red)', fontWeight: 600, letterSpacing: '0.04em'}}>BEST</div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

window.AppPagesLaptimes = { PageTimes };
