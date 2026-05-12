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

function PageTimes({ cars, tracks, lapTimes, lapTimesLoaded }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [trackId,  setTrackId]  = uSt('all');
  const [carId,    setCarId]    = uSt('all');
  const [validOnly, setValidOnly] = uSt(true);
  const [dateFrom, setDateFrom] = uSt('');
  const [dateTo,   setDateTo]   = uSt('');
  const [view,     setView]     = uSt('records'); // records | all | compare
  const [page,     setPage]     = uSt(1);
  const [selectedPlayers, setSelectedPlayers] = uSt([]);

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

  const exportCSV = () => {
    const header = [
      t('times.col.driver'), t('times.col.track'), t('times.col.car'),
      t('times.col.time'), 'S1', 'S2', 'S3', t('times.col.valid'), t('times.col.date')
    ].join(',');
    const rows = records.map(r =>
      [r.player, trackName(r.track), carName(r.car), fmtMs(r.ms),
       fmtMs(r.s1), fmtMs(r.s2), fmtMs(r.s3), r.valid ? t('common.yes') : t('common.no'), r.date].join(',')
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[header, ...rows].join('\n')], { type: 'text/csv' }));
    a.download = `tiempos-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
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
        <button className="btn btn-sm right" onClick={exportCSV}>
          <ITi.IconDownload size={11}/> CSV
        </button>

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
          <label className="row" style={{gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor:'pointer'}} onClick={()=>setValidOnly(v=>!v)}>
            <div className={`checkbox ${validOnly ? 'on' : ''}`}></div>
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
                    <th style={{width: 50}}>#</th>
                    <th>{t('times.col.driver')}</th>
                    <th>{t('times.col.track')}</th>
                    <th>{t('times.col.car')}</th>
                    <th style={{width: 110}}>{t('times.col.best')}</th>
                    <th style={{width: 90}}>S1</th>
                    <th style={{width: 90}}>S2</th>
                    <th style={{width: 90}}>S3</th>
                    <th style={{width: 110}}>{t('times.col.delta')}</th>
                    <th style={{width: 110}}>{t('times.col.date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((r, i) => {
                    const globalIndex = (page - 1) * PAGE_SIZE + i;
                    const trackBest = records.find(x => x.track === r.track);
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
    </>
  );
}

function ComparisonTable({ players, labelOf, tracks, laps, trackId, t }) {
  if (players.length < 1) {
    return (
      <div className="card"><div className="empty">{t('times.compare.empty_sel')}</div></div>
    );
  }
  const visibleTracks = trackId === 'all' ? tracks : tracks.filter(t => t.id === trackId);

  const bestMap = uMt(() => {
    const m = new Map();
    for (const l of laps) {
      const key = `${l.track}|${l.player}`;
      const cur = m.get(key);
      if (!cur || l.ms < cur.ms) m.set(key, l);
    }
    return m;
  }, [laps]);

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
