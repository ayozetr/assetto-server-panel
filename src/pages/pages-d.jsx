// Page: Tiempos (lap-time database with filters & comparisons)
const { useState: uSt, useMemo: uMt } = React;
const ITi = window.AppIcons;

const fmtMs = window.AppUtils.fmtMs;
const fmtDelta = (ms) => {
  if (ms == null) return '—';
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  return sign + fmtMs(Math.abs(ms)).replace(/^0:/, '');
};

function PageTimes({ cars, tracks, lapTimes, lapTimesLoaded }) {
  const [trackId, setTrackId] = uSt('all');
  const [carId, setCarId] = uSt('all');
  const [validOnly, setValidOnly] = uSt(true);
  const [view, setView] = uSt('records'); // records | compare
  const [selectedPlayers, setSelectedPlayers] = uSt([]);

  const allPlayers = uMt(() => Array.from(new Set(lapTimes.map(l => l.player))).sort(), [lapTimes]);

  const filtered = uMt(() => lapTimes.filter(l => {
    if (trackId !== 'all' && l.track !== trackId) return false;
    if (carId !== 'all' && l.car !== carId) return false;
    if (validOnly && !l.valid) return false;
    return true;
  }), [lapTimes, trackId, carId, validOnly]);

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

  const trackName = (id) => tracks.find(t => t.id === id)?.name || id;
  const carName = (id) => cars.find(c => c.id === id)?.name || id;

  const togglePlayer = (p) => setSelectedPlayers(s => s.includes(p) ? s.filter(x => x !== p) : (s.length >= 4 ? s : [...s, p]));

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Tiempos</h1>
        <p className="page-sub">Base de datos de vueltas registradas — filtra y compara entre pilotos.</p>
      </div>

      <div className="toolbar">
        <div className="segmented">
          <button className={view === 'records' ? 'active' : ''} onClick={()=>setView('records')}>Récords</button>
          <button className={view === 'compare' ? 'active' : ''} onClick={()=>setView('compare')}>Comparar pilotos</button>
        </div>
        <button className="btn btn-sm right" onClick={() => {
          const header = 'Piloto,Tramo,Coche,Tiempo,S1,S2,S3,Valida,Fecha';
          const rows = records.map(r =>
            [r.player, trackName(r.track), carName(r.car), fmtMs(r.ms), fmtMs(r.s1), fmtMs(r.s2), fmtMs(r.s3), r.valid ? 'Sí' : 'No', r.date].join(',')
          );
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([[header, ...rows].join('\n')], { type: 'text/csv' }));
          a.download = `tiempos-${new Date().toISOString().slice(0,10)}.csv`;
          a.click();
        }}>
          <ITi.IconDownload size={11}/> CSV
        </button>
        <div className="row" style={{gap: 6}}>
          <select className="select" value={trackId} onChange={e=>setTrackId(e.target.value)} style={{width: 220}}>
            <option value="all">Todos los tramos</option>
            {tracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="select" value={carId} onChange={e=>setCarId(e.target.value)} style={{width: 200}}>
            <option value="all">Todos los coches</option>
            {cars.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="row" style={{gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor:'pointer'}} onClick={()=>setValidOnly(v=>!v)}>
            <div className={`checkbox ${validOnly ? 'on' : ''}`}></div>
            Solo válidas
          </label>
        </div>
        <div className="right muted" style={{fontSize: 11.5}}>
          <span className="mono">{filtered.length}</span> vueltas · <span className="mono">{records.length}</span> récords
        </div>
      </div>

      {view === 'records' && (
        <div className="card">
          <div className="card-header">
            <ITi.IconTimer size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Mejor vuelta por piloto</div>
          </div>
          {!lapTimesLoaded && lapTimes.length === 0 ? (
            <div className="loading-row">
              <div style={{width:18,height:18,borderRadius:'50%',border:'2px solid var(--border)',borderTopColor:'var(--red)',animation:'spin 0.8s linear infinite'}}></div>
              Cargando tiempos…
            </div>
          ) : records.length === 0 ? (
            <div className="empty">No hay tiempos con esos filtros.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{width: 50}}>#</th>
                  <th>Piloto</th>
                  <th>Tramo</th>
                  <th>Coche</th>
                  <th style={{width: 110}}>Mejor</th>
                  <th style={{width: 90}}>S1</th>
                  <th style={{width: 90}}>S2</th>
                  <th style={{width: 90}}>S3</th>
                  <th style={{width: 110}}>Δ líder</th>
                  <th style={{width: 110}}>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {records.slice(0, 200).map((r, i) => {
                  const trackBest = records.find(x => x.track === r.track);
                  const delta = r.ms - trackBest.ms;
                  return (
                    <tr key={r.id}>
                      <td><div className={`player-pos ${i === 0 ? 'p1' : ''}`}>{i + 1}</div></td>
                      <td className="player-name">{r.player}</td>
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
          )}
        </div>
      )}

      {view === 'compare' && (
        <>
          <div className="card" style={{marginBottom: 16}}>
            <div className="card-header">
              <div className="card-title">Selecciona hasta 4 pilotos</div>
              <span className="right muted" style={{fontSize: 11.5}}>{selectedPlayers.length} / 4</span>
            </div>
            <div className="card-body">
              <div className="tag-row">
                {allPlayers.map(p => (
                  <button key={p}
                    className={`tag ${selectedPlayers.includes(p) ? 'active' : ''}`}
                    onClick={()=>togglePlayer(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <ComparisonTable
            players={selectedPlayers}
            tracks={tracks}
            laps={filtered}
            trackId={trackId}
          />
        </>
      )}
    </>
  );
}

function ComparisonTable({ players, tracks, laps, trackId }) {
  if (players.length < 1) {
    return (
      <div className="card"><div className="empty">Elige al menos 1 piloto para comparar.</div></div>
    );
  }
  const visibleTracks = trackId === 'all' ? tracks : tracks.filter(t => t.id === trackId);

  // Build best per (track, player)
  const bestMap = uMt(() => {
    const m = new Map();
    for (const l of laps) {
      const key = `${l.track}|${l.player}`;
      const cur = m.get(key);
      if (!cur || l.ms < cur.ms) m.set(key, l);
    }
    return m;
  }, [laps]);

  // For each track, compute the leader among selected players and per-player gap
  const rows = visibleTracks.map(t => {
    const cells = players.map(p => bestMap.get(`${t.id}|${p}`));
    const validMs = cells.filter(c => c).map(c => c.ms);
    const best = validMs.length ? Math.min(...validMs) : null;
    return { track: t, cells, best };
  }).filter(r => r.cells.some(c => c)); // hide tracks where nobody has a lap

  if (rows.length === 0) return (
    <div className="card"><div className="empty">Estos pilotos no tienen tiempos en común con los filtros actuales.</div></div>
  );

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Comparativa</div>
        <span className="right muted" style={{fontSize: 11.5}}>{rows.length} tramos</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Tramo</th>
            {players.map(p => <th key={p} style={{width: 160}}>{p}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.track.id}>
              <td>
                <div className="row" style={{gap: 10}}>
                  <div style={{width: 40, height: 24, borderRadius: 3, overflow:'hidden', background:'var(--bg-3)', flexShrink: 0}}>
                    <img src={r.track.thumb} style={{width:'100%', height:'100%', objectFit:'cover'}}/>
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
                const delta = c.ms - r.best;
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

window.AppPagesD = { PageTimes };
