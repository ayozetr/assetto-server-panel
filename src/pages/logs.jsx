// Page: Logs (live SSE stream + filtering). Split out of monitoring.jsx for
// size. Publishes into the shared `window.AppPagesMonitoring` namespace.
const { useState: useLogsState, useEffect: useLogsEffect, useRef: useLogsRef } = React;
const I2L = window.AppIcons;

function PageLogs({ server }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [paused, setPaused] = useLogsState(false);
  const [filter, setFilter] = useLogsState('all');
  const [logs, setLogs] = useLogsState([]);
  const [confirmClear, setConfirmClear] = useLogsState(false);
  const ref = useLogsRef(null);
  // Highest log id at the time the user pressed "Clear". Used to suppress
  // re-display of old entries when the SSE reconnects (server replays its
  // 500-line buffer on every connect via the `init` event).
  const clearedSeqRef = useLogsRef(0);

  useLogsEffect(() => {
    if (paused) return;
    let es;
    let backoff = 1000; // start at 1s, double up to 30s
    let reconnectTimer = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource('/api/logs/stream');
      es.addEventListener('init', e => {
        try {
          const data = JSON.parse(e.data);
          const cutoff = clearedSeqRef.current;
          setLogs(Array.isArray(data) ? data.filter(l => l.id > cutoff) : []);
        } catch {}
      });
      es.onmessage = e => {
        try {
          const line = JSON.parse(e.data);
          if (line.id <= clearedSeqRef.current) return; // honour clear cutoff for incoming
          setLogs(prev => {
            const next = [...prev, line];
            return next.length > 500 ? next.slice(-500) : next;
          });
        } catch {}
      };
      es.onerror = () => {
        es.close();
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) es.close();
    };
  }, [paused]);

  useLogsEffect(() => {
    if (ref.current && !paused) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [logs, paused]);

  const filtered = filter === 'all' ? logs : logs.filter(l => l.lvl === filter);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('log.title')}</h1>
        <p className="page-sub">{t('log.sub')}</p>
      </div>
      <div className="toolbar">
        <div className="segmented">
          {['all', 'info', 'ok', 'warn', 'error'].map(f => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? t('log.all') : f.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="right row" style={{gap: 6}}>
          <button className="btn btn-sm" onClick={() => setPaused(p => !p)}>
            {paused ? <><I2L.IconPlay size={11}/> {t('log.play')}</> : <><I2L.IconStop size={11}/> {t('log.pause')}</>}
          </button>
          <button className="btn btn-sm" onClick={() => setConfirmClear(true)}>
            <I2L.IconTrash size={11}/> {t('log.clear')}
          </button>
          <button className="btn btn-sm" onClick={() => {
            const text = filtered.map(l => `[${l.time}] [${l.lvl.toUpperCase()}] [${l.tag}] ${l.msg}`).join('\n');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = `ac-logs-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
            a.click();
          }}>
            <I2L.IconDownload size={11}/> {t('log.export')}
          </button>
        </div>
      </div>

      <div className="logs" ref={ref}>
        {filtered.length === 0 && <div style={{color:'#71717a'}}>{t('log.empty')}</div>}
        {filtered.map(l => (
          <div className="logs-line" key={l.id}>
            <span className="logs-time">{l.time}</span>
            <span className={`logs-level ${l.lvl}`}>{l.lvl.toUpperCase()}</span>
            <span className="logs-tag">[{l.tag}]</span>
            <span className="logs-msg">{l.msg}</span>
          </div>
        ))}
      </div>
      {confirmClear && window.AppPagesSettings?.ConfirmModal && (
        <window.AppPagesSettings.ConfirmModal
          title={t('log.clear')}
          message={t('log.clear_confirm')}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            // Remember the latest seen id so reconnects don't replay old buffer
            clearedSeqRef.current = logs.length ? logs[logs.length - 1].id : clearedSeqRef.current;
            setLogs([]);
            setConfirmClear(false);
          }}
        />
      )}
    </>
  );
}

window.AppPagesMonitoring = window.AppPagesMonitoring || {};
window.AppPagesMonitoring.PageLogs = PageLogs;
