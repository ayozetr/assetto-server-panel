// Page: Dashboard. Players and Logs live in sibling files (`players.jsx`,
// `logs.jsx`); each pushes its component into the shared
// `window.AppPagesMonitoring` namespace so app.jsx still consumes a single
// destructure.
const { useState, useEffect } = React;
const I2 = window.AppIcons;

// Dashboard
function PageDashboard({ server, players, sessionCfg, tracks, cars }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  // Prefer the live track reported by the running server; fall back to configured
  const liveTrackId    = server.status === 'running' && server.liveTrack ? server.liveTrack : sessionCfg.trackId;
  const track          = tracks.find(t => t.id === liveTrackId) || tracks.find(t => t.id === sessionCfg.trackId) || tracks[0];
  const configDiffers  = server.status === 'running' && server.liveTrack && server.liveTrack !== sessionCfg.trackId;
  const configuredTrack = configDiffers ? (tracks.find(t => t.id === sessionCfg.trackId)?.name || sessionCfg.trackId) : null;
  const carsCount = sessionCfg.carIds.length;
  const toast = window.AppShell ? window.AppShell.useToast() : { push: ()=>{} };

  const joinUrl = server.publicIp ? `https://acstuff.club/s/q:race/online/join?ip=${server.publicIp}&httpPort=${server.httpPort || 8081}` : '';
  const cmUrl = server.publicIp ? `acmanager://race/online/join?ip=${server.publicIp}&httpPort=${server.httpPort || 8081}` : '';

  const [activity, setActivity] = useState([]);
  useEffect(() => {
    fetch('/api/logs?n=100')
      .then(r => r.json())
      .then(d => {
        const notable = (d.lines || []).filter(l =>
          l.tag !== 'CFG' && (l.lvl !== 'info' || /connected|joined|lap completed|best lap/i.test(l.msg))
        );
        setActivity(notable.slice(-8).reverse().slice(0, 5));
      })
      .catch(() => {});
  }, []);

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
                    <div style={{fontSize: 14, fontWeight: 600}}>{track.name}</div>
                    <div style={{fontSize: 12, color: 'var(--text-muted)'}}>{track.city || track.loc} · {track.length} km · {sessionCfg.layout}</div>
                    <div className="row" style={{marginTop: 8, gap: 6}}>
                      <span className="badge badge-red">{sessionCfg.mode}</span>
                      <span className="badge">{carsCount}</span>
                      <span className="badge">{sessionCfg.laps} {t('dash.laps')}</span>
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
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{sessionCfg.time}:00</div>
                  </div>
                  <div>
                    <div className="field-label">{t('dash.weather')}</div>
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{sessionCfg.weather}</div>
                  </div>
                  <div>
                    <div className="field-label">{t('dash.damage')}</div>
                    <div style={{fontSize: 13, fontWeight: 500, marginTop: 2}}>{sessionCfg.damage}%</div>
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

      <div style={{marginTop: 16}}>
        <div className="card">
          <div className="card-header">
            <I2.IconClock size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('dash.activity')}</div>
          </div>
          {activity.length === 0 ? (
            <div className="empty" style={{padding: '28px 20px'}}>{t('common.not_found')}</div>
          ) : (
            <div style={{padding: '4px 0'}}>
              {activity.map((it, i) => {
                const dotColor = it.lvl === 'ok' ? '#16a34a' : it.lvl === 'error' ? 'var(--red)' : it.lvl === 'warn' ? '#f59e0b' : 'var(--text-faint)';
                return (
                  <div key={it.id} style={{display:'flex', gap: 12, padding: '9px 18px', borderBottom: i < activity.length - 1 ? '1px solid var(--border)' : 'none', alignItems:'center', overflow:'hidden'}}>
                    <span style={{width: 6, height: 6, borderRadius: 50, background: dotColor, flexShrink: 0}}></span>
                    <span style={{fontSize: 13, flex: 1, minWidth: 0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={it.msg}>{it.msg}</span>
                    {it.time && <span className="muted" style={{fontSize: 11.5, flexShrink: 0}}>{it.time}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Players and Logs publish PagePlayers/PageLogs into the same namespace from
// players.jsx / logs.jsx, which load after this file (see index.html order).
window.AppPagesMonitoring = window.AppPagesMonitoring || {};
window.AppPagesMonitoring.PageDashboard = PageDashboard;
