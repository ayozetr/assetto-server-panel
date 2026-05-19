// PagePresets — browse, save, rename and delete saved session presets.
//
// A preset is a JSON snapshot of the same `sessionCfg` shape used by
// `/api/session/apply`. Saving / loading is *not* directly tied to acServer:
// "Load into Session" pushes the preset's config into the parent's sessionCfg
// state and navigates to the Session page, where the operator reviews it and
// pushes Apply. This avoids two-paths-to-acServer with subtly different
// validation, and lets the user double-check before kicking the running
// session.
//
// The "Save as preset" modal is defined here and re-exported via
// `window.AppPagesContent.SavePresetModal` so the Session page can host the
// same modal under its own button.

const I = window.AppIcons;

function _localDate(s) {
  if (!s) return '';
  // SQLite default `datetime('now')` returns UTC without a Z suffix; append
  // it so the browser parses as UTC and then renders in the local timezone.
  const d = new Date(/\dZ$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString();
}

function _sessionsLabel(t, summary) {
  const parts = [];
  if (summary.practiceEnabled) parts.push(t('sess.row.practice'));
  if (summary.qualifyEnabled)  parts.push(t('sess.row.qualify'));
  if (summary.raceEnabled)     parts.push(t('sess.row.race'));
  return parts.join(' · ') || '—';
}

function _trackLabel(tracks, summary) {
  if (!summary.trackId) return null;
  const tr = (tracks || []).find(x => x.id === summary.trackId);
  const trackName = tr?.name || summary.trackId;
  if (!summary.layout) return trackName;
  const layoutShort = window.AppUtils?.layoutShortName?.(tr, summary.layout)
                   || tr?.layoutDetails?.[summary.layout]?.name
                   || summary.layout;
  return `${trackName} — ${layoutShort}`;
}

function PagePresets({ tracks, sessionCfg, canEdit, onAskSaveAs, onLoadPreset }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell ? window.AppShell.useToast() : { push: () => {} };
  const [presets, setPresets] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [renameTarget, setRenameTarget] = React.useState(null); // { id, name }
  const [deleteTarget, setDeleteTarget] = React.useState(null); // { id, name }

  // Stable refs for `t` and `toast`. The originals are rebound on every render
  // (`AppI18n.t.bind(...)` returns a new function ref every time and useToast
  // returns a fresh context value), so putting them in a useCallback dep array
  // means refresh() identity flips each render — and any useEffect that depends
  // on refresh() ends up firing in a tight loop ("loading…" never settles).
  // Capturing them via refs lets `refresh` keep an empty dep array.
  const tRef     = React.useRef(t);
  const toastRef = React.useRef(toast);
  tRef.current   = t;
  toastRef.current = toast;

  const refresh = React.useCallback(() => {
    setLoading(true);
    fetch('/api/session-presets')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(rows => setPresets(Array.isArray(rows) ? rows : []))
      .catch(e => toastRef.current.push(`${tRef.current('common.error')}: ${e.message}`, 'error'))
      .finally(() => setLoading(false));
  }, []);

  // Mount-only fetch — manual refresh from now on (the button below) plus the
  // window event fired by App.jsx after a successful save modal POST.
  React.useEffect(() => { refresh(); }, [refresh]);

  React.useEffect(() => {
    const onSaved = () => refresh();
    window.addEventListener('app:preset-saved', onSaved);
    return () => window.removeEventListener('app:preset-saved', onSaved);
  }, [refresh]);

  const handleLoad = (preset) => {
    fetch(`/api/session-presets/${preset.id}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(full => {
        onLoadPreset(full);
        toast.push(t('presets.toast.loaded').replace('{name}', full.name), 'ok');
      })
      .catch(e => toast.push(`${t('common.error')}: ${e.message}`, 'error'));
  };

  const handleRename = (newName) => {
    if (!renameTarget) return;
    fetch(`/api/session-presets/${renameTarget.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        toast.push(t('presets.toast.updated').replace('{name}', newName), 'ok');
        setRenameTarget(null);
        refresh();
      })
      .catch(e => {
        // Special-case the unique-name conflict for a friendlier message.
        const msg = /already exists/i.test(e.message)
          ? t('presets.toast.duplicate_name')
          : `${t('common.error')}: ${e.message}`;
        toast.push(msg, 'error');
      });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    const name = deleteTarget.name;
    fetch(`/api/session-presets/${deleteTarget.id}`, { method: 'DELETE' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        toast.push(t('presets.toast.deleted').replace('{name}', name), 'ok');
        setDeleteTarget(null);
        refresh();
      })
      .catch(e => toast.push(`${t('common.error')}: ${e.message}`, 'error'));
  };

  return (
    <>
      <div className="page-header" style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap: 12, flexWrap:'wrap'}}>
        <div>
          <h1 style={{margin: 0}}><I.IconFolder size={18}/> {t('presets.title')}</h1>
          <p className="page-sub" style={{margin: '6px 0 0', maxWidth: 720}}>{t('presets.sub')}</p>
        </div>
        <div style={{display:'flex', gap: 8, flexWrap:'wrap'}}>
          <button className="btn" onClick={refresh} disabled={loading} title={t('presets.refresh')} aria-label={t('presets.refresh')} style={{whiteSpace:'nowrap'}}>
            <I.IconRefresh size={13}/> {t('presets.refresh')}
          </button>
          {canEdit && (
            <button className="btn btn-primary" onClick={onAskSaveAs} style={{whiteSpace:'nowrap'}}>
              <I.IconPlus size={14}/> {t('presets.new')}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="card" style={{padding: 16, marginTop: 14, color:'var(--text-muted)'}}>
          {t('common.loading') || 'Loading…'}
        </div>
      ) : presets.length === 0 ? (
        <div className="card" style={{padding: 24, marginTop: 14, textAlign:'center'}}>
          <div style={{fontSize: 32, opacity: 0.4, marginBottom: 6}}><I.IconFolder size={32}/></div>
          <div style={{fontWeight: 600, marginBottom: 4}}>{t('presets.empty.title')}</div>
          <div style={{color:'var(--text-muted)', fontSize: 13}}>{t('presets.empty.body')}</div>
        </div>
      ) : (
        <div className="preset-grid" style={{display:'grid', gap: 12, gridTemplateColumns:'repeat(auto-fill, minmax(320px, 1fr))', marginTop: 14}}>
          {presets.map(p => (
            <PresetCard
              key={p.id}
              t={t}
              preset={p}
              tracks={tracks}
              canEdit={canEdit}
              onLoad={() => handleLoad(p)}
              onRename={() => setRenameTarget({ id: p.id, name: p.name })}
              onDelete={() => setDeleteTarget({ id: p.id, name: p.name })}
            />
          ))}
        </div>
      )}

      {renameTarget && (
        <RenamePresetModal
          t={t}
          initialName={renameTarget.name}
          onCancel={() => setRenameTarget(null)}
          onConfirm={handleRename}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          t={t}
          name={deleteTarget.name}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}
    </>
  );
}

function PresetCard({ t, preset, tracks, canEdit, onLoad, onRename, onDelete }) {
  const trackLabel = _trackLabel(tracks, preset.summary);
  return (
    <div className="card preset-card" style={{padding: 14, display:'flex', flexDirection:'column', gap: 10}}>
      <div>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap: 8}}>
          <div style={{fontWeight: 600, fontSize: 15, lineHeight: 1.3, wordBreak:'break-word'}}>{preset.name}</div>
        </div>
        {preset.description && (
          <div style={{fontSize: 12, color:'var(--text-muted)', marginTop: 4, whiteSpace:'pre-wrap', wordBreak:'break-word'}}>{preset.description}</div>
        )}
      </div>

      <div style={{display:'flex', flexDirection:'column', gap: 6, fontSize: 12, color:'var(--text-muted)'}}>
        <div style={{display:'flex', alignItems:'center', gap: 6}}>
          <I.IconCircuit size={12}/>
          <span>{trackLabel || t('presets.card.no_track')}</span>
        </div>
        <div style={{display:'flex', alignItems:'center', gap: 6}}>
          <I.IconCar size={12}/>
          <span>{t('presets.card.slot_count').replace('{n}', String(preset.summary.slotCount))}</span>
        </div>
        <div style={{display:'flex', alignItems:'center', gap: 6}}>
          <I.IconFlag size={12}/>
          <span>{_sessionsLabel(t, preset.summary)}</span>
        </div>
      </div>

      <div style={{fontSize: 11, color:'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 8, display:'flex', justifyContent:'space-between', gap: 8, flexWrap:'wrap'}}>
        <span>{t('presets.card.updated').replace('{date}', _localDate(preset.updatedAt))}</span>
        {preset.createdBy && <span>{t('presets.card.created_by').replace('{user}', preset.createdBy)}</span>}
      </div>

      <div style={{display:'flex', gap: 6, flexWrap:'wrap', marginTop: 2}}>
        <button className="btn btn-primary" style={{flex: 1, minWidth: 140}} onClick={onLoad}>
          <I.IconPlay size={12}/> {t('presets.card.load')}
        </button>
        {canEdit && (
          <>
            <button className="btn icon-btn" title={t('presets.card.rename')} aria-label={t('presets.card.rename')} onClick={onRename}>
              <I.IconEdit size={13}/>
            </button>
            <button className="btn icon-btn" title={t('presets.card.delete')} aria-label={t('presets.card.delete')} onClick={onDelete} style={{color:'var(--red)'}}>
              <I.IconTrash size={13}/>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Shared save modal: opened from both the Presets page's "Nueva plantilla"
// button and from the Session page's "Guardar como plantilla" button. The
// modal does not know about sessionCfg — the parent (App.jsx) reads the
// current state at submit time and POSTs.
function SavePresetModal({ open, onClose, onSave }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const trapRef = window.AppShell?.useFocusTrap ? window.AppShell.useFocusTrap(open) : { current: null };

  React.useEffect(() => {
    if (open) { setName(''); setDescription(''); setBusy(false); }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    Promise.resolve(onSave({ name: trimmed, description: description.trim() }))
      .then(() => { setBusy(false); onClose(); })
      .catch(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" onClick={busy ? null : onClose} role="presentation">
      <div ref={trapRef} className="modal" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('presets.save_modal.title')} tabIndex={-1}>
        <div className="modal-header">
          <I.IconFolder size={15}/>
          <div className="modal-title">{t('presets.save_modal.title')}</div>
        </div>
        <div className="modal-body" style={{display:'flex', flexDirection:'column', gap: 12}}>
          <div>
            <label className="field-label" htmlFor="preset-name">{t('presets.save_modal.name_label')}</label>
            <input id="preset-name" className="input" value={name} onChange={e=>setName(e.target.value)} maxLength={120} autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) submit(); }}/>
            <div className="field-hint">{t('presets.save_modal.name_hint')}</div>
          </div>
          <div>
            <label className="field-label" htmlFor="preset-desc">{t('presets.save_modal.desc_label')}</label>
            <textarea id="preset-desc" className="input" value={description} onChange={e=>setDescription(e.target.value)} maxLength={500} rows={3}/>
            <div className="field-hint">{t('presets.save_modal.desc_hint')}</div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={!name.trim() || busy}>
            <I.IconCheck size={13}/> {t('presets.save_modal.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenamePresetModal({ t, initialName, onCancel, onConfirm }) {
  const [name, setName] = React.useState(initialName);
  const trapRef = window.AppShell?.useFocusTrap ? window.AppShell.useFocusTrap(true) : { current: null };
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === initialName) return;
    onConfirm(trimmed);
  };
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div ref={trapRef} className="modal" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('presets.rename_modal.title')} tabIndex={-1}>
        <div className="modal-header">
          <I.IconEdit size={15}/>
          <div className="modal-title">{t('presets.rename_modal.title')}</div>
        </div>
        <div className="modal-body">
          <label className="field-label" htmlFor="preset-rename">{t('presets.rename_modal.name_label')}</label>
          <input id="preset-rename" className="input" value={name} onChange={e=>setName(e.target.value)} maxLength={120} autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) submit(); }}/>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={!name.trim() || name.trim() === initialName}>
            <I.IconCheck size={13}/> {t('presets.rename_modal.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDeleteModal({ t, name, onCancel, onConfirm }) {
  const trapRef = window.AppShell?.useFocusTrap ? window.AppShell.useFocusTrap(true) : { current: null };
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div ref={trapRef} className="modal" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="modal-header">
          <I.IconTrash size={15} style={{color:'var(--red)'}}/>
          <div className="modal-title">{t('presets.card.delete')}</div>
        </div>
        <div className="modal-body">
          <p style={{margin: 0, fontSize: 13, color:'var(--text-muted)'}}>
            {t('presets.delete_confirm').replace('{name}', name)}
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="btn btn-danger" onClick={onConfirm}>
            <I.IconTrash size={13}/> {t('presets.card.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

window.AppPagesContent = window.AppPagesContent || {};
window.AppPagesContent.PagePresets       = PagePresets;
window.AppPagesContent.SavePresetModal   = SavePresetModal;
