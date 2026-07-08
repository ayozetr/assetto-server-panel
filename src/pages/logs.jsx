// Page: Logs (live SSE stream + filtering). Split out of monitoring.jsx for
// size. Publishes into the shared `window.AppPagesMonitoring` namespace.
const { useState: useLogsState, useEffect: useLogsEffect, useRef: useLogsRef } = React;
const I2L = window.AppIcons;

function PageLogs({ server, isAdmin }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell.useToast();
  const [paused, setPaused] = useLogsState(false);
  const [filter, setFilter] = useLogsState('all');
  const [logs, setLogs] = useLogsState([]);
  const [confirmClear, setConfirmClear] = useLogsState(false);
  const [clearing, setClearing] = useLogsState(false);
  const ref = useLogsRef(null);

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
          setLogs(Array.isArray(data) ? data : []);
        } catch {}
      });
      // Server-side clear (POST /api/logs/clear) broadcasts this to every
      // open tab so the visible state stays in sync with the now-empty buffer.
      es.addEventListener('clear', () => setLogs([]));
      es.onmessage = e => {
        try {
          const line = JSON.parse(e.data);
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

  const filtered = filter === 'all' ? logs : logs.filter(l => (l.lvl || 'info') === filter);

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
          {isAdmin && (
            <button className="btn btn-sm" onClick={() => setConfirmClear(true)} disabled={clearing}>
              <I2L.IconTrash size={11}/> {t('log.clear')}
            </button>
          )}
          <button className="btn btn-sm" onClick={() => {
            const text = filtered.map(l => `[${l.time||''}] [${(l.lvl||'info').toUpperCase()}] [${l.tag||''}] ${l.msg}`).join('\n');
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `ac-logs-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
            a.click();
            // Free the blob URL after the download starts; mirrors the laptimes CSV export.
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          }}>
            <I2L.IconDownload size={11}/> {t('log.export')}
          </button>
        </div>
      </div>

      <div className="logs" ref={ref}>
        {filtered.length === 0 && <div style={{color:'#71717a'}}>{t('log.empty')}</div>}
        {filtered.map(l => (
          <div className="logs-line" key={l.id}>
            <span className="logs-time">{l.time || ''}</span>
            <span className={`logs-level ${l.lvl || 'info'}`}>{(l.lvl || 'info').toUpperCase()}</span>
            <span className="logs-tag">[{l.tag || ''}]</span>
            <span className="logs-msg">{l.msg}</span>
          </div>
        ))}
      </div>
      {confirmClear && window.AppPagesSettings?.ConfirmModal && (
        <window.AppPagesSettings.ConfirmModal
          title={t('log.clear')}
          message={t('log.clear_confirm')}
          onCancel={() => setConfirmClear(false)}
          onConfirm={async () => {
            setClearing(true);
            try {
              const r = await fetch('/api/logs/clear', { method: 'POST' });
              if (!r.ok) {
                toast.push(t('log.clear_err') || 'Failed to clear', 'warn');
              } else {
                // Optimistic local wipe; the SSE `clear` event will also
                // reach this tab and any others, keeping them all in sync.
                setLogs([]);
              }
            } catch {
              toast.push(t('log.clear_err') || 'Failed to clear', 'warn');
            } finally {
              setClearing(false);
              setConfirmClear(false);
            }
          }}
        />
      )}
    </>
  );
}

window.AppPagesMonitoring = window.AppPagesMonitoring || {};
window.AppPagesMonitoring.PageLogs = PageLogs;
