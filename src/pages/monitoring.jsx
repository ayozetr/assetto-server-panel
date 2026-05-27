// Page: Dashboard. Players and Logs live in sibling files (`players.jsx`,
// `logs.jsx`); each pushes its component into the shared
// `window.AppPagesMonitoring` namespace so app.jsx still consumes a single
// destructure.
const { useState, useEffect, useRef: useRefMon, useMemo: useMemoMon } = React;
const I2 = window.AppIcons;

// Splits the combined "<track>[-<layout>]" or "<track>/<layout>" string from
// acServer's /INFO endpoint into the two ids the catalogue + content API
// expect. Naive split('-') breaks for trackIds that contain a dash
// themselves (e.g. "trento-bondone"), so we walk dash positions and pick
// the longest prefix that matches a known track in the catalogue. Falls
// back to treating the whole string as the trackId with no layout.
function _splitLiveTrack(raw, tracks) {
  if (!raw) return [null, null];
  const list = tracks || [];
  if (list.some(t => t.id === raw)) return [raw, null];
  if (raw.includes('/')) {
    const i = raw.indexOf('/');
    return [raw.slice(0, i), raw.slice(i + 1)];
  }
  for (let i = raw.length - 1; i >= 1; i--) {
    if (raw[i] !== '-') continue;
    if (list.some(t => t.id === raw.slice(0, i))) {
      return [raw.slice(0, i), raw.slice(i + 1)];
    }
  }
  return [raw, null];
}

// ── Live track minimap with car dots ─────────────────────────────────────────
// Renders the current track's map.png as the canvas and animates one
// absolute-positioned dot per connected car at the position acServer streams
// over UDP (consumed by /api/positions/stream as SSE). The world→pixel
// projection follows the same formula Content Manager / CSP use, so the dots
// land on the trail like in CM's minimap. Self-contained: opens the SSE on
// mount, fetches the calibration once per (trackId, layoutId) change, closes
// everything on unmount. When the active combo has no map.png or map.ini the
// card renders a one-line "no map for this layout" placeholder instead of
// breaking the dashboard.
function LiveMapCard({ trackId, layoutId, tracks }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [meta,      setMeta]      = useState(null); // null=loading, false=no-map, {width,height,...}=ok
  const [positions, setPositions] = useState([]);
  // Default state is collapsed — the live map is opt-in once the user
  // clicks to expand. Persistence key is `ac-live-map-open` (positive
  // semantic: '1' iff explicitly expanded). Key was renamed from the old
  // `*-collapsed` so existing browser localStorage entries with the
  // previous "expanded by default" convention don't bleed through.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('ac-live-map-open') !== '1'; }
    catch { return true; }
  });
  const imgRef = useRefMon(null);

  useEffect(() => {
    try { localStorage.setItem('ac-live-map-open', collapsed ? '0' : '1'); } catch {}
  }, [collapsed]);

  // Resolve a friendly base track name + layout name through the existing
  // catalogue so the card title reads "Red Bull Ring — Grand Prix" instead
  // of the raw slugs. Falls back to whatever data is available.
  const trackObj = (tracks || []).find(t => t && t.id === trackId);
  const trackName  = trackObj ? ((window.AppUtils?.trackBaseName?.(trackObj)) || trackObj.name) : trackId;
  const layoutName = (layoutId && trackObj) ? (window.AppUtils?.layoutShortName?.(trackObj, layoutId)) : '';

  // Load the calibration on every (track, layout) change. 404 = no map.ini
  // shipped for this combo (3 stock Kunos tracks lacked it before the manual
  // file copy); state falls to `false` and the card explains the situation
  // instead of rendering a broken `<img>`.
  useEffect(() => {
    if (!trackId) return;
    let cancelled = false;
    setMeta(null);
    setPositions([]);
    const qs = layoutId ? `?layout=${encodeURIComponent(layoutId)}` : '';
    fetch(`/api/content/tracks/${encodeURIComponent(trackId)}/map-meta${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setMeta(d && d.width > 0 ? d : false); })
      .catch(() => { if (!cancelled) setMeta(false); });
    return () => { cancelled = true; };
  }, [trackId, layoutId]);

  // Open the SSE stream for live positions. Re-mount the EventSource when the
  // active combo changes so a session apply doesn't keep streaming positions
  // against an outdated map. EventSource handles reconnection on its own
  // when the network blips, so we don't need a manual reconnect loop here.
  // When the card is collapsed we tear the stream down — no point pushing
  // 4Hz packets to a hidden widget. The SSE broadcaster on the server is
  // ref-counted so the last subscriber closing stops the timer entirely.
  useEffect(() => {
    if (!trackId || meta === null || meta === false || collapsed) return;
    const es = new EventSource('/api/positions/stream');
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d && Array.isArray(d.positions)) setPositions(d.positions);
      } catch {}
    };
    es.onerror = () => { /* browser auto-reconnects; nothing to do */ };
    return () => { try { es.close(); } catch {} };
  }, [trackId, layoutId, meta, collapsed]);

  // Project a (world_x, world_z) onto the PNG as a percentage of width/height.
  // The PNG natural dimensions are (WIDTH + 2*MARGIN) × (HEIGHT + 2*MARGIN);
  // expressing the dot position as a percentage means the image can be
  // scaled by CSS (max-width: 100%) without re-doing the math.
  const project = useMemoMon(() => {
    if (!meta) return () => null;
    const pngW = meta.width  + 2 * meta.margin;
    const pngH = meta.height + 2 * meta.margin;
    const sf   = meta.scaleFactor || 1;
    return (worldX, worldZ) => {
      const px = (worldX + meta.xOffset) / sf + meta.margin;
      const py = (worldZ + meta.zOffset) / sf + meta.margin;
      return { left: `${(px / pngW) * 100}%`, top: `${(py / pngH) * 100}%` };
    };
  }, [meta]);

  // Render-state branches:
  //   meta === null  → endpoint still loading (avoid flashing the "no map" copy)
  //   meta === false → confirmed no map.ini for this combo
  //   meta is object → render image + dots
  // The whole card header doubles as the collapse toggle (button semantics
  // via role="button" + tabIndex + key handler so it's keyboard-reachable).
  const toggle = () => setCollapsed(c => !c);
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  return (
    <div className="card" style={{marginTop: 16}}>
      <div
        className="card-header card-header-clickable"
        onClick={toggle}
        onKeyDown={onKey}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
      >
        <I2.IconCircuit size={14} style={{color:'var(--red)'}}/>
        <div className="card-title">{t('dash.live_map') || 'Live track'}</div>
        <span className="muted" style={{fontSize: 11.5, marginLeft: 8}}>
          {trackName}{layoutName ? ` · ${layoutName}` : ''}
        </span>
        <span style={{marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8}}>
          {meta && !collapsed && positions.length > 0 && (
            <span className="badge badge-green">{positions.length}</span>
          )}
          <span className={`card-collapse-chevron${collapsed ? ' collapsed' : ''}`} aria-hidden="true">
            <I2.IconChevronDown size={14}/>
          </span>
        </span>
      </div>
      {!collapsed && (
        <div className="card-body" style={{padding: 0}}>
          {meta === null ? (
            <div className="loading-row" style={{padding: '32px 18px'}}>{t('common.loading') || 'Loading…'}</div>
          ) : meta === false ? (
            <div className="empty" style={{padding: '24px 18px'}}>
              {t('dash.live_map_unavailable') || 'Live map not available for this layout.'}
            </div>
          ) : (
            <div className="live-map-wrap">
              <img
                ref={imgRef}
                className="live-map-img"
                src={`/api/content/tracks/${encodeURIComponent(trackId)}/map${layoutId ? `?layout=${encodeURIComponent(layoutId)}` : ''}`}
                alt=""
                draggable={false}
              />
              {positions.map(p => {
                const pos = project(p.x, p.z);
                if (!pos) return null;
                return (
                  <div key={p.id} className="live-map-dot" style={pos}>
                    <span className="live-map-dot-marker" aria-hidden="true"></span>
                    <span className="live-map-dot-label">{p.name}</span>
                  </div>
                );
              })}
              {positions.length === 0 && (
                <div className="live-map-empty">{t('dash.live_map_waiting') || 'Waiting for position updates…'}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Dashboard
// Bytes → human-readable label. Mirrors the BeamNG sibling panel so the two
// dashboards format disk-usage consistently. Inlined here rather than
// shared because the panels are independent codebases.
function formatBytesMonAC(b) {
  if (!b) return '0';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function PageDashboard({ server, players, sessionCfg, tracks, cars }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;

  // Dashboard extras (mod-only disk usage + 24 h activity + acServer
  // version): polled lazily every 30 s because the disk walk is real work
  // and the values rarely change. Same pattern as BeamMP's
  // /api/dashboard/extra.
  const [extras, setExtras] = useState({ contentBytes: 0, activeDrivers24h: 0, laps24h: 0, acVersion: null });
  useEffect(() => {
    const load = () => {
      fetch('/api/dashboard/extra')
        .then(r => r.json())
        .then(d => { if (d && !d.error) setExtras(d); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);
  // Prefer the live track reported by the running server; fall back to configured
  const liveTrackId    = server.status === 'running' && server.liveTrack ? server.liveTrack : sessionCfg.trackId;
  const track          = tracks.find(t => t.id === liveTrackId) || tracks.find(t => t.id === sessionCfg.trackId) || tracks[0];
  const configDiffers  = server.status === 'running' && server.liveTrack && server.liveTrack !== sessionCfg.trackId;
  const configuredTrack = configDiffers ? (tracks.find(t => t.id === sessionCfg.trackId)?.name || sessionCfg.trackId) : null;
  const carsCount = (sessionCfg.slots || []).length;
  const toast = window.AppShell ? window.AppShell.useToast() : { push: ()=>{} };

  // Activity card defaults collapsed (same convention as the live-map card —
  // explicit opt-in via click). Persisted under `ac-activity-open`,
  // positive semantic so the absence-of-key state is unambiguously
  // collapsed. Renamed from `*-collapsed` to orphan prior localStorage
  // values whose default was the opposite.
  const [activityCollapsed, setActivityCollapsed] = useState(() => {
    try { return localStorage.getItem('ac-activity-open') !== '1'; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('ac-activity-open', activityCollapsed ? '0' : '1'); } catch {}
  }, [activityCollapsed]);

  // Translate the raw acServer weather id (e.g. `7_heavy_clouds`) to the
  // localised label the Session page uses. Fall back to the raw id so an
  // unknown preset still surfaces something readable instead of nothing.
  const WEATHER_KEYS = {
    '3_clear':         'sess.weather.clear',
    '4_mid_clear':     'sess.weather.mid_clear',
    '5_light_clouds':  'sess.weather.light_clouds',
    '6_mid_clouds':    'sess.weather.mid_clouds',
    '7_heavy_clouds':  'sess.weather.heavy_clouds',
    '2_light_fog':     'sess.weather.light_fog',
    '1_heavy_fog':     'sess.weather.heavy_fog',
  };
  const weatherLabel = WEATHER_KEYS[sessionCfg.weather] ? t(WEATHER_KEYS[sessionCfg.weather]) : (sessionCfg.weather || '—');

  // The new Session model has independent per-session toggles; the Dashboard
  // shows the first enabled one as the "primary" with its duration/laps.
  const primaryMode = sessionCfg.practiceEnabled ? { label: t('sess.row.practice'), value: `${sessionCfg.practiceTime || 0} min` }
                    : sessionCfg.qualifyEnabled  ? { label: t('sess.row.qualify'),  value: `${sessionCfg.qualifyTime  || 0} min` }
                    : sessionCfg.raceEnabled     ? { label: t('sess.row.race'),     value: `${sessionCfg.raceLaps     || 0} ${t('sess.unit.laps')}` }
                    : { label: '—', value: '' };

  const joinUrl = server.publicIp ? `https://acstuff.club/s/q:race/online/join?ip=${server.publicIp}&httpPort=${server.httpPort || 8081}` : '';
  const cmUrl = server.publicIp ? `acmanager://race/online/join?ip=${server.publicIp}&httpPort=${server.httpPort || 8081}` : '';

  const [activity, setActivity] = useState([]);
  useEffect(() => {
    const NOISE = /^(?:\s*content\/\S+\.(?:ini|kn5|ksanim|wav|fbx|dds)\s+ok\s*$|REQ\b|\{|\}|PAGE:|Serve |TCP packet|RECEIVED \d|Dispatching TCP|GET |POST |HEAD |listening on |plugin lines absent|plugin not configured|protocol version:|socket error:|parse error:|WARNING:\s*MAX_CONTACTS_PER_KM\b|WARNING:\s*pitstop window\b|WARNING:\s*tyre\b|Loading\b|Reading\b|Reset\b)/i;
    // Resolve `ks_toyota_ae86` → "Toyota AE86" from the cars catalogue
    // so the activity card never leaks the raw folder ID. Falls back to a
    // formatName-style title-cased version when the car isn't loaded yet
    // (catalogue still fetching) so the line is at least readable.
    const formatCarId = (rawId) => {
      if (!rawId) return '';
      const c = (cars || []).find(c => c && c.id === rawId);
      if (c?.name) return c.name;
      return rawId.replace(/[_-]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    };
    const formatTrackPath = (raw) => {
      if (!raw) return '';
      const [trackId, layoutId] = raw.includes('/') ? raw.split('/') : raw.split('-');
      const tk = (tracks || []).find(t => t && t.id === trackId);
      if (!tk) return layoutId ? `${trackId} (${layoutId})` : trackId;
      const base = (window.AppUtils?.trackBaseName?.(tk)) || tk.name;
      const layout = layoutId ? (window.AppUtils?.layoutShortName?.(tk, layoutId)) : '';
      return layout ? `${base} (${layout})` : base;
    };
    const stripPrefix = (s) => s
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/i, '')
      .replace(/^(INFO|WARN|ERROR|DEBUG)\s+/i, '')
      .replace(/^\[[A-Z_0-9]{2,12}\]\s*/, '');
    const fmt = (l) => {
      if (!l || !l.msg) return null;
      if (l.tag === 'CFG' || l.tag === 'HTTP') return null;
      if (NOISE.test(l.msg.trim())) return null;
      if (/\bCAR_INFO\b/.test(l.msg)) return null;
      const body = stripPrefix(l.msg).trim();
      let m;
      if ((m = body.match(/^JOIN\s+(.+?)\s+\([^)]+\)\s+car_id=\d+\s+model=(\S+)/))) {
        return { ...l, kind: 'join',  text: t('activity.join', { name: m[1], car: formatCarId(m[2]) }) };
      }
      if ((m = body.match(/^LEAVE\s+(.+?)\s+car_id=/))) {
        return { ...l, kind: 'leave', text: t('activity.leave', { name: m[1] }) };
      }
      if ((m = body.match(/^LAP\s+(.+?)\s+([\d.]+)s\s+cuts=(\d+)/))) {
        const secs  = parseFloat(m[2]);
        const mins  = Math.floor(secs / 60);
        const rest  = (secs - mins * 60).toFixed(3).padStart(6, '0');
        const time  = `${mins}:${rest}`;
        const cuts  = parseInt(m[3], 10);
        const base = t('activity.lap', { name: m[1], time });
        return { ...l, kind: 'lap', text: cuts ? `${base} ${t('activity.lap_cuts', { cuts })}` : base };
      }
      if ((m = body.match(/^(?:NEW_SESSION|SESSION_INFO)\s+(.+?)\s+\(([^)]+)\)\s+track=(\S+)/))) {
        return { ...l, kind: 'session', text: t('activity.session', { type: m[1], track: formatTrackPath(m[3]) }) };
      }
      if (/^COLLISION BETWEEN:\s*(.+?)\s*\[\]/i.test(body)) {
        const who = body.match(/^COLLISION BETWEEN:\s*(.+?)\s*\[\]/i)[1];
        return { ...l, kind: 'warn', text: t('activity.collision', { who }) };
      }
      if ((m = body.match(/^Clean exit, driver disconnected:\s*(.+?)\s*\[\]?\s*$/i))) {
        return { ...l, kind: 'leave', text: t('activity.leave', { name: m[1] }) };
      }
      if (/^Dynamic track\b/i.test(body))   return { ...l, kind: 'session', text: t('activity.dynamic_track') };
      if (/^Sending welcome message\b/i.test(body)) return null;
      if (l.lvl === 'error') return { ...l, kind: 'error', text: body };
      if (l.lvl === 'warn')  return { ...l, kind: 'warn',  text: body };
      if (l.lvl === 'ok' && /\b(connected|joined|best lap|validated|success)\b/i.test(body))
        return { ...l, kind: 'ok', text: body };
      return null;
    };
    const load = () => {
      fetch('/api/logs?n=500')
        .then(r => r.json())
        .then(d => {
          const items = (d.lines || []).map(fmt).filter(Boolean);
          setActivity(items.slice(-5).reverse());
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [tracks, cars]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('dash.title')}</h1>
        <p className="page-sub">{t('dash.metrics')}</p>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">{t('dash.metrics')}</div>
          <div className="kpi-value" style={{fontSize: 20, paddingTop: 4}}>
            {server.status === 'running' && <span style={{color: '#16a34a'}}>● {t('topbar.running')}</span>}
            {server.status === 'stopped' && <span style={{color: 'var(--text-muted)'}}>● {t('topbar.stopped')}</span>}
            {(server.status === 'starting' || server.status === 'stopping') && <span style={{color: '#f59e0b'}}>● {server.status === 'starting' ? t('topbar.starting') : t('topbar.stopping')}</span>}
          </div>
          <div className="kpi-meta">{t('dash.uptime')}: {server.uptime}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('dash.players')}</div>
          <div className="kpi-value">{server.players}<span className="unit">/ {server.slots}</span></div>
          <div className="bar"><div className="bar-fill" style={{width: `${(server.players/server.slots)*100}%`}}></div></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('dash.cpu')}</div>
          <div className="kpi-value">{server.cpu}<span className="unit">%</span></div>
          <div className="kpi-meta" title={server.cpuName} style={{whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
            <I2.IconChip size={10} style={{verticalAlign:'-1px', marginRight: 4}}/>{server.cpuName}
          </div>
          <div className="bar" style={{marginTop: 6}}><div className="bar-fill" style={{width: `${server.cpu}%`}}></div></div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('dash.ram')}</div>
          <div className="kpi-value">{server.ram}<span className="unit">MB</span></div>
          <div className="kpi-meta">{server.ramTotal || '—'} MB</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('dash.mods_disk') || 'Mods on disk'}</div>
          <div className="kpi-value">{formatBytesMonAC(extras.contentBytes)}</div>
          <div className="kpi-meta">{extras.acVersion ? `acServer v${extras.acVersion}` : (t('dash.mods_disk_meta') || 'excludes Kunos content')}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('dash.joins_today') || 'Joins (24 h)'}</div>
          <div className="kpi-value">{extras.activeDrivers24h}</div>
          <div className="kpi-meta">{t('dash.joins_today_meta') || 'distinct drivers seen in the last 24 h'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('dash.laps_today') || 'Laps (24 h)'}</div>
          <div className="kpi-value">{extras.laps24h}</div>
          <div className="kpi-meta">{t('dash.laps_today_meta') || 'laps recorded in the last 24 h'}</div>
        </div>
      </div>

      {server.status === 'running' && server.publicIp && (
        <div className="card" style={{marginTop: 16, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', gap: 16, flexDirection: 'row'}}>
          <div style={{display:'flex', alignItems:'center', gap:12}}>
            <div style={{background:'var(--bg-3)', color:'var(--text)', width:38, height:38, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center'}}>
              <I2.IconLink size={18} />
            </div>
            <div>
              <div style={{fontWeight:600, fontSize:14}}>{t('dash.join')}</div>
              <div className="mono muted" style={{fontSize:11.5}}>{server.publicIp}:{server.httpPort || 8081}</div>
            </div>
          </div>
          <div className="row" style={{gap: 8}}>
            <button className="btn" onClick={() => {
                const text = joinUrl;
                if (navigator.clipboard && window.isSecureContext) {
                  navigator.clipboard.writeText(text).then(() => toast.push(t('common.success'), 'success')).catch(() => {
                    const el = document.createElement('textarea');
                    el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
                    document.body.appendChild(el); el.focus(); el.select();
                    document.execCommand('copy'); document.body.removeChild(el);
                    toast.push(t('common.success'), 'success');
                  });
                } else {
                  const el = document.createElement('textarea');
                  el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
                  document.body.appendChild(el); el.focus(); el.select();
                  document.execCommand('copy'); document.body.removeChild(el);
                  toast.push(t('common.success'), 'success');
                }
              }}>
              <I2.IconCopy size={13}/> <span className="hide-mobile">{t('dash.copy_link')}</span>
            </button>
            <a href={cmUrl} className="btn btn-primary">
              <I2.IconPlay size={13}/> <span className="hide-mobile">{t('dash.open_cm')}</span>
            </a>
          </div>
        </div>
      )}

      <div className="grid-2" style={{marginTop: server.status === 'running' && server.publicIp ? 0 : 16}}>
        <div className="card">
          <div className="card-header">
            <I2.IconFlag size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('dash.session')}</div>
            {server.status === 'running' && server.liveTrack && (
              <span className="badge badge-green right">LIVE</span>
            )}
          </div>
          <div className="card-body">
            {!track ? (
              <div className="muted" style={{fontSize: 13, padding: '4px 0 8px'}}>{t('common.loading')}</div>
            ) : (
              <>
                <div className="row" style={{gap: 14}}>
                  <div style={{width: 120, height: 68, borderRadius: 6, overflow:'hidden', background: 'var(--bg-3)'}}>
                    <img src={track.thumb} style={{width:'100%', height:'100%', objectFit:'cover'}} alt=""
                      onError={e => { e.target.style.display='none'; }}/>
                  </div>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: 14, fontWeight: 600}}>{(window.AppUtils?.trackBaseName?.(track)) || track.name}</div>
                    <div style={{fontSize: 12, color: 'var(--text-muted)'}}>
                      {track.city || track.loc} · {track.length} km
                      {sessionCfg.layout && <> · {(window.AppUtils?.layoutShortName?.(track, sessionCfg.layout)) || (track.layoutDetails?.[sessionCfg.layout]?.name || sessionCfg.layout)}</>}
                    </div>
                    <div className="row" style={{marginTop: 8, gap: 6}}>
                      <span className="badge badge-red">{primaryMode.label}</span>
                      <span className="badge">{carsCount} {t('dash.cars')}</span>
                      {primaryMode.value && <span className="badge">{primaryMode.value}</span>}
                    </div>
                  </div>
                </div>
                {configDiffers && (
                  <div style={{
                    marginTop: 8, padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                    background: 'color-mix(in srgb, #f59e0b 10%, var(--bg-2))',
                    border: '1px solid color-mix(in srgb, #f59e0b 30%, transparent)',
                    fontSize: 11.5, color: 'var(--text-muted)',
                  }}>
                    <I2.IconSettings size={10} style={{verticalAlign:'-1px', marginRight: 4}}/>
                    <strong style={{color:'var(--text)'}}>{configuredTrack}</strong>
                  </div>
                )}
                <div className="divider"></div>
                <div className="grid-3">
                  <div>
                    <div className="field-label">{t('dash.time')}</div>
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{String(sessionCfg.time ?? 0).padStart(2, '0')}:00</div>
                  </div>
                  <div>
                    <div className="field-label">{t('dash.weather')}</div>
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{weatherLabel}</div>
                  </div>
                  <div>
                    <div className="field-label">{t('sess.temp')}</div>
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{sessionCfg.airTemp ?? '—'}°C</div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <I2.IconPlayers size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('dash.players')}</div>
            <span className="badge right">{players.length}</span>
          </div>
          {server.status !== 'running' ? (
            <div className="empty">{t('topbar.stopped')}</div>
          ) : players.length === 0 ? (
            <div className="empty">{t('dash.no_players')}</div>
          ) : (
            <div>
              {players.slice(0, 5).map((p, i) => (
                <div className="player-row" key={p.id}>
                  <div className={`player-pos ${i === 0 ? 'p1' : ''}`}>{i + 1}</div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div className="player-name">{p.name}</div>
                    <div className="player-car">{p.car}</div>
                  </div>
                  <div className="mono muted">{p.best}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {server.status === 'running' && players.length > 0 && (() => {
        // acServer's /INFO collapses the running combo into a single string
        // (e.g. "ks_red_bull_ring-layout_gp"); split it back into the two
        // ids the content API expects. Prefer the running-state values over
        // sessionCfg because if the operator changed config without
        // restarting, drivers are on the OLD track and the map should match
        // what they actually see.
        const [liveTrackBareId, liveLayoutBareId] = _splitLiveTrack(server.liveTrack, tracks);
        const mapTrackId  = liveTrackBareId  || sessionCfg.trackId;
        const mapLayoutId = liveLayoutBareId || sessionCfg.layout;
        return mapTrackId ? (
          <LiveMapCard trackId={mapTrackId} layoutId={mapLayoutId} tracks={tracks}/>
        ) : null;
      })()}

      <div style={{marginTop: 16}}>
        <div className="card">
          <div
            className="card-header card-header-clickable"
            onClick={() => setActivityCollapsed(c => !c)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActivityCollapsed(c => !c); } }}
            role="button"
            tabIndex={0}
            aria-expanded={!activityCollapsed}
          >
            <I2.IconClock size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('dash.activity')}</div>
            <span style={{marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8}}>
              {!activityCollapsed && activity.length > 0 && (
                <span className="badge">{activity.length}</span>
              )}
              <span className={`card-collapse-chevron${activityCollapsed ? ' collapsed' : ''}`} aria-hidden="true">
                <I2.IconChevronDown size={14}/>
              </span>
            </span>
          </div>
          {!activityCollapsed && (activity.length === 0 ? (
            <div className="empty" style={{padding: '28px 20px'}}>{t('common.not_found')}</div>
          ) : (
            <div style={{padding: '4px 0'}}>
              {activity.map((it, i) => {
                const dotColor =
                  it.kind === 'join'    ? '#16a34a' :
                  it.kind === 'leave'   ? 'var(--text-faint)' :
                  it.kind === 'lap'     ? '#2563eb' :
                  it.kind === 'session' ? '#a855f7' :
                  it.kind === 'ok'      ? '#16a34a' :
                  it.kind === 'error'   ? 'var(--red)' :
                  it.kind === 'warn'    ? '#f59e0b' :
                                          'var(--text-faint)';
                return (
                  <div key={it.id} style={{display:'flex', gap: 12, padding: '9px 18px', borderBottom: i < activity.length - 1 ? '1px solid var(--border)' : 'none', alignItems:'center', overflow:'hidden'}}>
                    <span style={{width: 6, height: 6, borderRadius: 50, background: dotColor, flexShrink: 0}}></span>
                    <span style={{fontSize: 13, flex: 1, minWidth: 0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={it.msg}>{it.text || it.msg}</span>
                    {it.time && <span className="muted" style={{fontSize: 11.5, flexShrink: 0}}>{it.time}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// Players and Logs publish PagePlayers/PageLogs into the same namespace from
// players.jsx / logs.jsx, which load after this file (see index.html order).
window.AppPagesMonitoring = window.AppPagesMonitoring || {};
window.AppPagesMonitoring.PageDashboard = PageDashboard;
