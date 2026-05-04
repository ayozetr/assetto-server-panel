// Page: Mods — Secure mod uploader (cars & tracks)
const { useState: uStE, useEffect: uEtE, useRef: uRfE } = React;
const I5 = window.AppIcons;

// Allowed formats info
const FORMAT_INFO = [
  { ext: '.zip', label: 'ZIP', color: '#3b82f6', engine: 'node-stream-zip (JS puro)' },
  { ext: '.rar', label: 'RAR', color: '#8b5cf6', engine: 'node-unrar-js (WASM)' },
  { ext: '.7z',  label: '7Z',  color: '#f59e0b', engine: '7zip-bin (bundled)' },
];

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function ProgressBar({ pct }) {
  return (
    <div style={{
      height: 6, borderRadius: 99,
      background: 'var(--bg-3)', overflow: 'hidden', marginTop: 10,
    }}>
      <div style={{
        height: '100%', borderRadius: 99,
        background: 'var(--red)',
        width: `${pct}%`,
        transition: 'width 120ms ease',
      }}/>
    </div>
  );
}

function HistoryItem({ item, t }) {
  const isOk    = item.ok;
  const isTrack = item.modType === 'track';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '10px 14px',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 'var(--radius)',
        background: isOk
          ? (isTrack ? 'color-mix(in srgb, #3b82f6 14%, transparent)' : 'color-mix(in srgb, var(--red) 14%, transparent)')
          : 'color-mix(in srgb, #ef4444 12%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, fontSize: 18,
      }}>
        {isOk ? (isTrack ? '🏁' : '🚗') : <I5.IconX size={15} style={{color:'#ef4444'}}/>}
      </div>
      <div style={{flex: 1, minWidth: 0}}>
        <div style={{
          fontSize: 12.5, fontWeight: 600,
          color: isOk ? 'var(--text)' : '#ef4444',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {isOk ? item.modId : item.filename}
        </div>
        {isOk ? (
          <div className="muted" style={{fontSize: 11, marginTop: 2}}>
            {isTrack ? t('mods.type_track') : t('mods.type_car')} · {item.filesExtracted} {t('mods.files')} · <span className="mono">{item.destination}</span>
          </div>
        ) : (
          <div style={{fontSize: 11, color: '#ef4444', marginTop: 2}}>{item.error}</div>
        )}
      </div>
      <div className="muted" style={{fontSize: 10.5, flexShrink: 0}}>{item.time}</div>
    </div>
  );
}

function PageMods({ isAdmin }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k) => k;
  const toast = window.AppShell.useToast();

  const [dragging,  setDragging]  = uStE(false);
  const [file,      setFile]      = uStE(null);
  const [progress,  setProgress]  = uStE(0);
  const [uploading, setUploading] = uStE(false);
  const [result,    setResult]    = uStE(null);
  const [history,   setHistory]   = uStE([]);
  const [uploadMaxMb, setUploadMaxMb] = uStE(500);
  const inputRef = uRfE(null);

  // Load limit from backend
  uEtE(() => {
    fetch('/api/panel/settings')
      .then(r => r.json())
      .then(d => { if (d.uploadMaxMb) setUploadMaxMb(d.uploadMaxMb); })
      .catch(() => {});
  }, []);

  const handleDragOver  = (e) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = ()  => setDragging(false);
  const handleDrop      = (e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) selectFile(f);
  };
  const handleFileInput = (e) => {
    const f = e.target.files?.[0];
    if (f) selectFile(f);
    e.target.value = '';
  };

  const selectFile = (f) => {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    if (!['.zip', '.rar', '.7z'].includes(ext)) {
      toast.push(t('mods.err_format'), 'error'); return;
    }
    if (f.size > uploadMaxMb * 1024 * 1024) {
      toast.push(t('mods.err_size') + ` (máx. ${uploadMaxMb} MB)`, 'error'); return;
    }
    setFile(f);
    setResult(null);
    setProgress(0);
  };

  const upload = () => {
    if (!file || uploading) return;
    setUploading(true);
    setProgress(0);
    setResult(null);

    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/mods/upload');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 90));
    };

    xhr.onload = () => {
      setProgress(100);
      const now = new Date().toLocaleTimeString();
      try {
        const d = JSON.parse(xhr.responseText);
        if (d.ok) {
          setResult({ ok: true, ...d });
          setHistory(h => [{
            ok: true, filename: file.name, ...d, time: now,
          }, ...h.slice(0, 9)]);
          toast.push(d.modType === 'car' ? t('mods.success_car') : t('mods.success_track'), 'success');
          setFile(null);
        } else {
          setResult({ ok: false, error: d.error || t('common.error') });
          setHistory(h => [{
            ok: false, filename: file.name, error: d.error || t('common.error'), time: now,
          }, ...h.slice(0, 9)]);
          toast.push(d.error || t('common.error'), 'error');
        }
      } catch {
        const err = 'Error al procesar respuesta del servidor';
        setResult({ ok: false, error: err });
        toast.push(err, 'error');
      }
      setUploading(false);
    };

    xhr.onerror = () => {
      const err = t('common.net_error');
      setResult({ ok: false, error: err });
      toast.push(err, 'error');
      setUploading(false);
      setProgress(0);
    };

    xhr.send(fd);
  };

  const clearFile = () => { setFile(null); setResult(null); setProgress(0); };

  if (!isAdmin) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">{t('mods.title')}</h1>
        </div>
        <div className="card">
          <div className="empty">
            <I5.IconLock size={20} style={{display:'block', margin:'0 auto 10px'}}/>
            {t('mods.admin_only')}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('mods.title')}</h1>
        <p className="page-sub">{t('mods.sub')}</p>
      </div>

      <div className="grid-2" style={{gridTemplateColumns: '1.2fr 1fr', alignItems: 'start', gap: 20}}>

        {/* ── Left col: uploader ── */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>

          {/* Drop zone */}
          <div
            onClick={() => !uploading && inputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              border: `2px dashed ${dragging ? 'var(--red)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-lg)',
              padding: '40px 24px',
              textAlign: 'center',
              cursor: uploading ? 'default' : 'pointer',
              background: dragging
                ? 'color-mix(in srgb, var(--red) 6%, transparent)'
                : 'var(--bg-2)',
              transition: 'border-color 150ms, background 150ms',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Animated shimmer when dragging */}
            {dragging && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--red) 8%, transparent) 50%, transparent 100%)',
                animation: 'shimmer 1.2s infinite',
                pointerEvents: 'none',
              }}/>
            )}

            <div style={{
              width: 52, height: 52, borderRadius: 'var(--radius)',
              background: 'color-mix(in srgb, var(--red) 12%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px',
            }}>
              <I5.IconUpload size={24} style={{color: 'var(--red)'}}/>
            </div>

            {file ? (
              <>
                <div style={{fontWeight: 600, fontSize: 14, marginBottom: 4}}>{file.name}</div>
                <div className="muted" style={{fontSize: 12}}>{formatBytes(file.size)}</div>
              </>
            ) : (
              <>
                <div style={{fontWeight: 600, fontSize: 14, marginBottom: 6}}>{t('mods.drop')}</div>
                <div className="muted" style={{fontSize: 12}}>{t('mods.drop_hint')}</div>
              </>
            )}

            <input
              ref={inputRef}
              type="file"
              accept=".zip,.rar,.7z"
              onChange={handleFileInput}
              style={{display: 'none'}}
            />
          </div>

          {/* Progress + actions */}
          {file && (
            <div className="card">
              <div className="card-body" style={{gap: 12}}>
                <div className="row-between">
                  <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                    <I5.IconPackage size={14} style={{color: 'var(--red)'}}/>
                    <span style={{fontSize: 13, fontWeight: 500, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                      {file.name}
                    </span>
                    <span className="badge" style={{fontSize: 10}}>
                      {file.name.slice(file.name.lastIndexOf('.')).toUpperCase()}
                    </span>
                  </div>
                  {!uploading && (
                    <button className="icon-btn" onClick={clearFile} title={t('common.cancel')}>
                      <I5.IconX size={13}/>
                    </button>
                  )}
                </div>

                {uploading && <ProgressBar pct={progress}/>}

                {!uploading && (
                  <button className="btn btn-primary" style={{width: '100%', justifyContent: 'center'}} onClick={upload}>
                    <I5.IconUpload size={13}/> {t('mods.upload_btn')}
                  </button>
                )}
                {uploading && (
                  <div className="row" style={{gap: 8, justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13}}>
                    <I5.IconRefresh size={14} style={{animation: 'spin 1s linear infinite'}}/>
                    {t('mods.uploading')} {progress}%
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Result card */}
          {result && (
            <div className="card" style={{
              borderColor: result.ok ? 'color-mix(in srgb, #22c55e 35%, var(--border))' : 'color-mix(in srgb, #ef4444 35%, var(--border))',
            }}>
              <div className="card-header">
                {result.ok
                  ? <I5.IconCheck size={14} style={{color: '#22c55e'}}/>
                  : <I5.IconX size={14} style={{color: '#ef4444'}}/>}
                <div className="card-title" style={{color: result.ok ? '#22c55e' : '#ef4444'}}>
                  {result.ok
                    ? (result.modType === 'car' ? t('mods.success_car') : t('mods.success_track'))
                    : t('mods.error_title')}
                </div>
              </div>
              {result.ok ? (
                <div className="card-body col" style={{gap: 8}}>
                  <div style={{display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12.5}}>
                    <span className="muted">{t('mods.result_type')}</span>
                    <span style={{fontWeight: 500}}>
                      {result.modType === 'car' ? '🚗 ' + t('mods.type_car') : '🏁 ' + t('mods.type_track')}
                    </span>
                    <span className="muted">{t('mods.result_id')}</span>
                    <span className="mono">{result.modId}</span>
                    <span className="muted">{t('mods.result_files')}</span>
                    <span>{result.filesExtracted} {t('mods.files')}</span>
                    <span className="muted">{t('mods.result_dest')}</span>
                    <span className="mono" style={{fontSize: 11, wordBreak: 'break-all'}}>{result.destination}</span>
                  </div>
                </div>
              ) : (
                <div className="card-body">
                  <p style={{margin: 0, fontSize: 12.5, color: '#ef4444'}}>{result.error}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right col: info + history ── */}
        <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>

          {/* Format support card */}
          <div className="card">
            <div className="card-header">
              <I5.IconShield size={14} style={{color: 'var(--red)'}}/>
              <div className="card-title">{t('mods.formats_title')}</div>
            </div>
            <div className="card-body col" style={{gap: 10}}>
              {FORMAT_INFO.map(f => (
                <div key={f.ext} style={{display: 'flex', alignItems: 'center', gap: 10}}>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4,
                    background: f.color + '22', color: f.color,
                    fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
                    minWidth: 36, textAlign: 'center',
                  }}>{f.label}</span>
                  <div style={{flex: 1}}>
                    <div style={{fontSize: 12, color: 'var(--text-muted)'}}>{f.engine}</div>
                  </div>
                  <I5.IconCheck size={13} style={{color: '#22c55e', flexShrink: 0}}/>
                </div>
              ))}
              <div style={{
                marginTop: 6, padding: '8px 10px', borderRadius: 'var(--radius)',
                background: 'var(--bg-3)', fontSize: 11.5, color: 'var(--text-muted)',
              }}>
                🔒 {t('mods.security_note')}
              </div>
            </div>
          </div>

          {/* Detection logic card */}
          <div className="card">
            <div className="card-header">
              <I5.IconSearch size={14} style={{color: 'var(--red)'}}/>
              <div className="card-title">{t('mods.detection_title')}</div>
            </div>
            <div className="card-body col" style={{gap: 10}}>
              <div style={{display: 'flex', gap: 10, alignItems: 'flex-start'}}>
                <span style={{fontSize: 18, flexShrink: 0}}>🚗</span>
                <div>
                  <div style={{fontSize: 12.5, fontWeight: 600, marginBottom: 2}}>{t('mods.type_car')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>
                    <span className="mono">.kn5</span> + (<span className="mono">data/</span> {t('mods.or')} <span className="mono">data.acd</span>)
                  </div>
                </div>
              </div>
              <div style={{display: 'flex', gap: 10, alignItems: 'flex-start'}}>
                <span style={{fontSize: 18, flexShrink: 0}}>🏁</span>
                <div>
                  <div style={{fontSize: 12.5, fontWeight: 600, marginBottom: 2}}>{t('mods.type_track')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>
                    <span className="mono">models.ini</span> + <span className="mono">ai/</span>
                  </div>
                </div>
              </div>
              <div style={{
                padding: '8px 10px', borderRadius: 'var(--radius)',
                background: 'var(--bg-3)', fontSize: 11.5, color: 'var(--text-muted)',
              }}>
                {t('mods.extraction_note')}
              </div>
            </div>
          </div>

          {/* Limit info */}
          <div style={{
            padding: '8px 12px', borderRadius: 'var(--radius)',
            background: 'var(--bg-3)',
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
            color: 'var(--text-muted)',
          }}>
            <I5.IconSettings size={13}/>
            {t('mods.limit_label')}: <strong style={{color: 'var(--text)'}}>{uploadMaxMb} MB</strong>
            <span style={{marginLeft: 'auto', fontSize: 11}}>{t('mods.limit_hint')}</span>
          </div>

          {/* Upload history */}
          {history.length > 0 && (
            <div className="card">
              <div className="card-header">
                <I5.IconHistory size={14} style={{color: 'var(--red)'}}/>
                <div className="card-title">{t('mods.history_title')}</div>
                <button className="btn btn-sm right" onClick={() => setHistory([])}>
                  <I5.IconX size={11}/> {t('mods.history_clear')}
                </button>
              </div>
              <div>
                {history.map((item, i) => (
                  <HistoryItem key={i} item={item} t={t}/>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </>
  );
}

window.AppPagesE = { PageMods };
