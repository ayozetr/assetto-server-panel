// Page: Audit log viewer. Split out of settings.jsx. The ACTION_ICONS /
// ACTION_COLOR maps live next to their only consumer.
const { useState: useStateA, useEffect: useEffectA, useRef: useRefA } = React;
const I4A = window.AppIcons;

const ACTION_ICONS = {
  'server.start':   '▶',
  'server.stop':    '■',
  'server.restart': '↺',
  'player.kick':    '⚡',
  'player.ban':     '🚫',
  'config.save':    '💾',
  'session.apply':  '🏁',
  'mod.install':    '📦',
  'user.create':    '👤+',
  'user.update':    '👤✎',
  'user.delete':    '👤-',
  'whitelist.add':  '✓',
  'admin.backup':   '⬇',
};
const ACTION_COLOR = {
  'server.start':   'var(--green,#22c55e)',
  'server.stop':    'var(--red)',
  'server.restart': 'var(--yellow,#eab308)',
  'player.kick':    'var(--yellow,#eab308)',
  'player.ban':     'var(--red)',
  'config.save':    'var(--text-muted)',
  'session.apply':  'var(--text-muted)',
  'mod.install':    'var(--text-muted)',
  'user.create':    'var(--text-muted)',
  'user.update':    'var(--text-muted)',
  'user.delete':    'var(--red)',
  'whitelist.add':  'var(--green,#22c55e)',
  'admin.backup':   'var(--text-muted)',
};

function PageAudit() {
  const t    = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k) => k;
  const I5   = window.AppIcons;
  const [rows,    setRows]    = useStateA([]);
  const [loading, setLoading] = useStateA(true);
  const [loadingMore, setLoadingMore] = useStateA(false);
  const [hasMore, setHasMore] = useStateA(false);
  const [nextCursor, setNextCursor] = useStateA(null);

  // Monotonic request id: every load() bumps it, and only the response whose id
  // still matches the latest is allowed to paint. Guards against a slow refresh
  // landing after a newer one and clobbering the fresher rows out of order.
  const reqIdRef = useRefA(0);

  const load = () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    fetch('/api/audit?limit=50')
      .then(r => r.json())
      .then(d => {
        if (reqId !== reqIdRef.current) return; // stale response, a newer load() superseded it
        // Backwards-compatible: response is { rows, hasMore, nextCursor } now,
        // but old callers / older server might still return a bare array.
        if (Array.isArray(d)) { setRows(d); setHasMore(false); setNextCursor(null); }
        else if (d && Array.isArray(d.rows)) { setRows(d.rows); setHasMore(!!d.hasMore); setNextCursor(d.nextCursor); }
      })
      .catch(() => {})
      .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
  };

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    fetch(`/api/audit?limit=50&before=${nextCursor}`)
      .then(r => r.json())
      .then(d => {
        if (d && Array.isArray(d.rows)) {
          setRows(prev => [...prev, ...d.rows]);
          setHasMore(!!d.hasMore);
          setNextCursor(d.nextCursor);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  useEffectA(load, []);

  const fmt = (iso) => {
    try {
      // Server timestamps are naive UTC ("2026-07-08 12:00:00") and need a 'Z'
      // to be parsed as UTC instead of local. But if the string already carries
      // zone info (trailing Z, or a ±HH:MM / ±HHMM offset), appending another
      // 'Z' corrupts it — so only add it when the zone is missing.
      const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
      return new Date(hasZone ? iso : iso + 'Z').toLocaleString();
    } catch { return iso; }
  };

  return (
    <>
      <div className="page-header" style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',flexWrap:'wrap',gap:12}}>
        <div>
          <h1 className="page-title">{t('audit.title')}</h1>
          <p className="page-sub">{t('audit.sub')}</p>
        </div>
        <div className="row" style={{gap: 6, marginTop: 4}}>
          <a className="btn" href="/api/admin/backup" download>
            <I5.IconDownload size={13}/> {t('audit.backup') || 'Download DB'}
          </a>
          <button className="btn" onClick={load}>
            <I5.IconReload size={13}/> {t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="card" style={{padding:0,overflow:'hidden'}}>
        {loading ? (
          <div className="empty" style={{padding:32}}>{t('common.loading')}</div>
        ) : rows.length === 0 ? (
          <div className="empty" style={{padding:32}}>{t('audit.empty')}</div>
        ) : (
          <table className="table" style={{margin:0}}>
            <thead>
              <tr>
                <th scope="col">{t('audit.col_time')}</th>
                <th scope="col">{t('audit.col_actor')}</th>
                <th scope="col">{t('audit.col_action')}</th>
                <th scope="col">{t('audit.col_target')}</th>
                <th scope="col">{t('audit.col_detail')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={{whiteSpace:'nowrap',color:'var(--text-muted)',fontSize:12}}>{fmt(r.logged_at)}</td>
                  <td style={{fontWeight:600}}>{r.actor}</td>
                  <td>
                    <span style={{
                      display:'inline-flex',alignItems:'center',gap:5,
                      fontFamily:'monospace',fontSize:12,
                      color: ACTION_COLOR[r.action] || 'var(--text)',
                    }}>
                      <span>{ACTION_ICONS[r.action] || '·'}</span>
                      {r.action}
                    </span>
                  </td>
                  <td style={{fontFamily:'monospace',fontSize:12}}>{r.target || '—'}</td>
                  <td style={{color:'var(--text-muted)',fontSize:12}}>{r.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {hasMore && !loading && (
          <div style={{padding:12, textAlign:'center', borderTop:'1px solid var(--border)'}}>
            <button className="btn" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? t('common.loading') : (t('audit.load_more') || 'Load more')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

window.AppPagesSettings = window.AppPagesSettings || {};
window.AppPagesSettings.PageAudit = PageAudit;
