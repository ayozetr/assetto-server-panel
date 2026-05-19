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

function PagePresets({ tracks, canEdit, onAskBuild, onAskEdit, onLoadPreset }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell ? window.AppShell.useToast() : { push: () => {} };
  const [presets, setPresets] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
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
            <button className="btn btn-primary" onClick={onAskBuild} style={{whiteSpace:'nowrap'}}>
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
              onEdit={() => onAskEdit(p)}
              onDelete={() => setDeleteTarget({ id: p.id, name: p.name })}
            />
          ))}
        </div>
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

function PresetCard({ t, preset, tracks, canEdit, onLoad, onEdit, onDelete }) {
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
            <button className="btn icon-btn" title={t('presets.card.edit')} aria-label={t('presets.card.edit')} onClick={onEdit}>
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

// Custom preset builder. Unlike SavePresetModal (which snapshots the current
// sessionCfg from the Session page), this modal lets the operator compose a
// preset from scratch: pick track + layout, build the grid by adding cars and
// optional skins one slot at a time, toggle each session with its duration,
// and pick weather/time/penalties — all without touching the live session.
//
// We mirror the same sessionCfg shape the rest of the app uses so the saved
// config is interchangeable with snapshot presets and with /api/session/apply.
function BuildPresetModal({ open, onClose, onSave, tracks, cars, sessionCfg, editing }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const trapRef = window.AppShell?.useFocusTrap ? window.AppShell.useFocusTrap(open) : { current: null };

  // When `editing` is supplied, hydrate the draft from the loaded preset so the
  // modal opens pre-filled. Otherwise start from a sensible new-preset default.
  // Memoised on `editing` so React.useEffect below picks up identity changes
  // (open + editing flip together when the user clicks Edit on a card).
  const makeDefaults = React.useCallback(() => {
    if (editing) {
      const c = editing.config || {};
      return {
        name:            editing.name || '',
        description:     editing.description || '',
        trackId:         c.trackId || '',
        layout:          c.layout || '',
        slots:           Array.isArray(c.slots) ? c.slots.map(s => ({ id: s.id, skin: s.skin || null })) : [],
        maxClients:      c.maxClients ?? 24,
        practiceEnabled: !!c.practiceEnabled,
        qualifyEnabled:  !!c.qualifyEnabled,
        raceEnabled:     !!c.raceEnabled,
        practiceTime:    c.practiceTime ?? 10,
        qualifyTime:     c.qualifyTime  ?? 15,
        raceLaps:        c.raceLaps     ?? 10,
        time:            c.time         ?? 14,
        weather:         c.weather      || '3_clear',
        airTemp:         c.airTemp      ?? 22,
        penalties:       !!c.penalties,
      };
    }
    return {
      name: '',
      description: '',
      trackId: '',
      layout: '',
      slots: [],
      maxClients: 24,
      practiceEnabled: true,
      qualifyEnabled:  true,
      raceEnabled:     true,
      practiceTime: 10,
      qualifyTime:  15,
      raceLaps:     10,
      time:      14,
      weather:   '3_clear',
      airTemp:   22,
      penalties: true,
    };
  }, [editing]);

  const [draft, setDraft] = React.useState(makeDefaults);
  const [busy, setBusy]   = React.useState(false);
  const [carPicker, setCarPicker] = React.useState({ open: false, carId: '', skin: '' });

  React.useEffect(() => {
    if (open) { setDraft(makeDefaults()); setBusy(false); setCarPicker({ open: false, carId: '', skin: '' }); }
  }, [open, makeDefaults]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  // useMemo calls MUST stay above the `if (!open) return null` early-return —
  // otherwise the hook count differs between the closed-render (no useMemo)
  // and the open-render (useMemo runs), which trips React error #310
  // "Rendered more hooks during this render than during the previous render".
  // Sort the catalogues alphabetically: /api/cars and /api/tracks come back
  // in filesystem order which is hostile to "I'm looking for X" scanning.
  const sortedCars = React.useMemo(
    () => [...cars].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [cars]
  );
  const sortedTracks = React.useMemo(
    () => [...tracks].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [tracks]
  );

  if (!open) return null;

  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const anyEnabled = draft.practiceEnabled || draft.qualifyEnabled || draft.raceEnabled;

  // Resolve the currently picked track so the layout dropdown can list its
  // variants. Falls back to a stub when the trackId points at content that
  // is no longer installed (preserves the id without crashing the modal).
  const track = tracks.find(tr => tr.id === draft.trackId);

  // Picker car (the one currently selected in the "Add slot" widget).
  const pickerCar = cars.find(c => c.id === carPicker.carId);
  const pickerSkins = pickerCar?.skins || [];

  // Copies the current sessionCfg into the draft so the operator can start
  // from "what's loaded in the editor" and tweak instead of from zero.
  const importFromSession = () => {
    if (!sessionCfg) return;
    setDraft(d => ({
      ...d,
      trackId:         sessionCfg.trackId || '',
      layout:          sessionCfg.layout || '',
      slots:           Array.isArray(sessionCfg.slots) ? sessionCfg.slots.map(s => ({ id: s.id, skin: s.skin || null })) : [],
      maxClients:      sessionCfg.maxClients ?? d.maxClients,
      practiceEnabled: !!sessionCfg.practiceEnabled,
      qualifyEnabled:  !!sessionCfg.qualifyEnabled,
      raceEnabled:     !!sessionCfg.raceEnabled,
      practiceTime:    sessionCfg.practiceTime ?? d.practiceTime,
      qualifyTime:     sessionCfg.qualifyTime  ?? d.qualifyTime,
      raceLaps:        sessionCfg.raceLaps     ?? d.raceLaps,
      time:            sessionCfg.time         ?? d.time,
      weather:         sessionCfg.weather      || d.weather,
      airTemp:         sessionCfg.airTemp      ?? d.airTemp,
      penalties:       !!sessionCfg.penalties,
    }));
  };

  const onTrackChange = (newId) => {
    const tr = tracks.find(x => x.id === newId);
    // Reset the layout to the new track's first option — the previous value
    // is meaningless under a different circuit and would otherwise leave the
    // layout select showing a stale id.
    const firstLayout = tr?.layouts?.[0] || '';
    setDraft(d => ({ ...d, trackId: newId, layout: firstLayout }));
  };

  const addPickedSlot = () => {
    if (!carPicker.carId) return;
    setDraft(d => ({ ...d, slots: [...d.slots, { id: carPicker.carId, skin: carPicker.skin || null }] }));
    // Keep the picker open so adding several copies of the same car (or
    // different skins of the same car) only takes one click per slot.
  };

  const removeSlot = (idx) => setDraft(d => ({ ...d, slots: d.slots.filter((_, i) => i !== idx) }));
  const clearSlots = ()    => setDraft(d => ({ ...d, slots: [] }));

  const sessionRows = [
    { key: 'Practice', flag: 'practiceEnabled', value: 'practiceTime', unit: 'min',  label: t('sess.row.practice') },
    { key: 'Qualify',  flag: 'qualifyEnabled',  value: 'qualifyTime',  unit: 'min',  label: t('sess.row.qualify')  },
    { key: 'Race',     flag: 'raceEnabled',     value: 'raceLaps',     unit: 'laps', label: t('sess.row.race')     },
  ];

  const submit = () => {
    const name = draft.name.trim();
    if (!name || busy) return;
    if (!anyEnabled) return;
    setBusy(true);
    // Build the wire payload — drop the modal-only `name`/`description`
    // fields out of the `config` blob so they don't get round-tripped
    // through the saved JSON. The `id` (when editing) tells the parent
    // handler to PUT instead of POST.
    const { name: _n, description: _d, ...config } = draft;
    Promise.resolve(onSave({ id: editing?.id, name, description: draft.description.trim(), config }))
      .then(() => { setBusy(false); onClose(); })
      .catch(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" onClick={busy ? null : onClose} role="presentation">
      <div
        ref={trapRef}
        className="modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t(editing ? 'presets.build_modal.edit_title' : 'presets.build_modal.title')}
        tabIndex={-1}
        style={{ maxWidth: 760, maxHeight: 'calc(100vh - 40px)', display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-header">
          <I.IconFolder size={15}/>
          <div className="modal-title">{t(editing ? 'presets.build_modal.edit_title' : 'presets.build_modal.title')}</div>
          {!editing && (
            <button className="btn btn-sm" style={{marginLeft: 'auto'}} onClick={importFromSession} disabled={busy}>
              <I.IconRefresh size={11}/> {t('presets.build_modal.from_session')}
            </button>
          )}
        </div>
        {/* `minHeight: 0` is load-bearing: without it, the flex item's
            default min-height is its content size, the body doesn't shrink
            to honour the modal's max-height, the modal grows past the
            viewport, and each `.card` (which has `overflow: hidden`) gets
            squeezed by flex-shrink and clips its own contents. With
            min-height: 0 the body actually scrolls and every card keeps
            its natural height. */}
        <div className="modal-body" style={{ overflowY: 'auto', flex: 1, minHeight: 0, gap: 18 }}>
          {/* ── Name + description ─────────────────────────────────────── */}
          <div className="grid-2" style={{gridTemplateColumns: '1fr 1.4fr'}}>
            <div className="field">
              <label className="field-label" htmlFor="bp-name">{t('presets.save_modal.name_label')}</label>
              <input id="bp-name" className="input" autoFocus value={draft.name} maxLength={120}
                onChange={e => set('name', e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) submit(); }}/>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="bp-desc">{t('presets.save_modal.desc_label')}</label>
              <input id="bp-desc" className="input" value={draft.description} maxLength={500}
                onChange={e => set('description', e.target.value)}/>
            </div>
          </div>

          {/* ── Track + layout ─────────────────────────────────────────── */}
          <div className="card" style={{padding: 14}}>
            <div className="row" style={{marginBottom: 10}}>
              <I.IconCircuit size={13} style={{color:'var(--red)'}}/>
              <div className="card-title">{t('presets.build_modal.track_section')}</div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">{t('presets.build_modal.track_label')}</label>
                <select className="select" value={draft.trackId} onChange={e => onTrackChange(e.target.value)}>
                  <option value="">{t('presets.build_modal.no_track_option')}</option>
                  {sortedTracks.map(tr => (
                    <option key={tr.id} value={tr.id}>{tr.name || tr.id}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label">{t('presets.build_modal.layout_label')}</label>
                <select className="select" value={draft.layout} onChange={e => set('layout', e.target.value)} disabled={!track}>
                  {track && track.layouts.length > 0
                    ? track.layouts.map(l => (
                      <option key={l} value={l}>
                        {(window.AppUtils?.layoutShortName?.(track, l)) || track.layoutDetails?.[l]?.name || l || 'Default'}
                      </option>
                    ))
                    : <option value="">—</option>
                  }
                </select>
              </div>
            </div>
          </div>

          {/* ── Sessions ───────────────────────────────────────────────── */}
          <div className="card" style={{padding: 14}}>
            <div className="row" style={{marginBottom: 10}}>
              <I.IconFlag size={13} style={{color:'var(--red)'}}/>
              <div className="card-title">{t('presets.build_modal.sessions_section')}</div>
            </div>
            <div className="col" style={{gap: 10}}>
              {sessionRows.map(row => {
                const enabled = !!draft[row.flag];
                return (
                  <div key={row.key} className="row" style={{gap: 12, alignItems:'center'}}>
                    {window.AppShell?.Switch ? (
                      <window.AppShell.Switch on={enabled} ariaLabel={row.label} onChange={v => set(row.flag, v)}/>
                    ) : (
                      <div className={`switch ${enabled ? 'on' : ''}`} onClick={() => set(row.flag, !enabled)}/>
                    )}
                    <div style={{flex: 1, fontSize: 13, fontWeight: 500, opacity: enabled ? 1 : 0.5}}>{row.label}</div>
                    <input className="input" type="number" min="1" max="9999" style={{width: 90, opacity: enabled ? 1 : 0.5}}
                      value={draft[row.value] ?? 0}
                      onChange={e => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) set(row.value, Math.max(1, Math.min(9999, Math.round(n))));
                      }}
                      disabled={!enabled}/>
                    <div className="muted" style={{fontSize: 11, width: 36, opacity: enabled ? 1 : 0.5}}>
                      {row.unit === 'laps' ? t('sess.unit.laps') : t('sess.unit.min')}
                    </div>
                  </div>
                );
              })}
              {!anyEnabled && (
                <div className="muted" style={{fontSize: 11.5, color:'var(--red)'}}>{t('sess.no_session_enabled')}</div>
              )}
              <div className="field" style={{marginTop: 4}}>
                <label className="field-label">{t('sess.slots')}</label>
                <input className="input" type="number" min="2" max="64" style={{maxWidth: 120}}
                  value={draft.maxClients}
                  onChange={e => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) set('maxClients', Math.max(2, Math.min(64, Math.round(n))));
                  }}/>
              </div>
            </div>
          </div>

          {/* ── Conditions ─────────────────────────────────────────────── */}
          <div className="card" style={{padding: 14}}>
            <div className="row" style={{marginBottom: 10}}>
              <I.IconCloud size={13} style={{color:'var(--red)'}}/>
              <div className="card-title">{t('presets.build_modal.cond_section')}</div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">{t('sess.time')}</label>
                <div className="row" style={{gap: 10}}>
                  <input type="range" min="0" max="23" value={draft.time}
                    onChange={e => set('time', Number(e.target.value))}
                    style={{flex: 1, accentColor: 'var(--red)', minWidth: 0}}/>
                  <div className="mono" style={{minWidth: 48, textAlign:'right', fontSize: 12}}>{String(draft.time).padStart(2,'0')}:00</div>
                </div>
              </div>
              <div className="field">
                <label className="field-label">{t('sess.weather')}</label>
                <select className="select" value={draft.weather} onChange={e => set('weather', e.target.value)}>
                  <option value="3_clear">{t('sess.weather.clear')}</option>
                  <option value="4_mid_clear">{t('sess.weather.mid_clear')}</option>
                  <option value="5_light_clouds">{t('sess.weather.light_clouds')}</option>
                  <option value="6_mid_clouds">{t('sess.weather.mid_clouds')}</option>
                  <option value="7_heavy_clouds">{t('sess.weather.heavy_clouds')}</option>
                  <option value="2_light_fog">{t('sess.weather.light_fog')}</option>
                  <option value="1_heavy_fog">{t('sess.weather.heavy_fog')}</option>
                </select>
              </div>
              <div className="field">
                <label className="field-label">{t('sess.temp')}</label>
                <div className="row" style={{gap: 10}}>
                  <input type="range" min="0" max="40" value={draft.airTemp}
                    onChange={e => set('airTemp', Number(e.target.value))}
                    style={{flex: 1, accentColor: 'var(--red)', minWidth: 0}}/>
                  <div className="mono" style={{minWidth: 48, textAlign:'right', fontSize: 12}}>{draft.airTemp}°C</div>
                </div>
              </div>
              <div className="field">
                <label className="field-label">{t('sess.penalties')}</label>
                <div className="row" style={{gap: 10, alignItems:'center', minHeight: 34}}>
                  {window.AppShell?.Switch ? (
                    <window.AppShell.Switch on={draft.penalties} ariaLabel={t('sess.row.penalties') || 'Penalties'} onChange={v => set('penalties', v)}/>
                  ) : (
                    <div className={`switch ${draft.penalties ? 'on' : ''}`} onClick={() => set('penalties', !draft.penalties)}/>
                  )}
                  <span className="muted" style={{fontSize: 12, lineHeight: 1.35}}>{t('sess.penalties.hint')}</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── Cars (slots) ───────────────────────────────────────────── */}
          <div className="card" style={{padding: 14}}>
            <div className="row" style={{marginBottom: 10, alignItems:'center'}}>
              <I.IconCar size={13} style={{color:'var(--red)'}}/>
              <div className="card-title">{t('presets.build_modal.cars_section')}</div>
              <span className="badge right">{draft.slots.length} {t('sess.slots').toLowerCase?.() || 'slots'}</span>
            </div>

            {/* Add-slot picker — inline flex row so the Add button reliably
                aligns with the bottom of the two selects regardless of label
                wrapping, and wraps to the next line on narrow widths instead
                of squeezing into an unreadable column. */}
            <div style={{display:'flex', gap: 8, alignItems:'flex-end', flexWrap:'wrap'}}>
              <div className="field" style={{flex: '2 1 220px', minWidth: 0}}>
                <label className="field-label">{t('presets.build_modal.car_label')}</label>
                <select className="select" value={carPicker.carId}
                  onChange={e => setCarPicker({ open: true, carId: e.target.value, skin: '' })}>
                  <option value="">{t('presets.build_modal.pick_car')}</option>
                  {sortedCars.map(c => (
                    <option key={c.id} value={c.id}>{c.brand ? `${c.brand} · ${c.name}` : c.name || c.id}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{flex: '1.4 1 160px', minWidth: 0}}>
                <label className="field-label">{t('presets.build_modal.skin_label')}</label>
                <select className="select" value={carPicker.skin}
                  onChange={e => setCarPicker(s => ({ ...s, skin: e.target.value }))}
                  disabled={!pickerCar || pickerSkins.length === 0}>
                  <option value="">{t('presets.build_modal.any_skin')}</option>
                  {pickerSkins.map(sk => (
                    <option key={sk} value={sk}>{sk}</option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" onClick={addPickedSlot} disabled={!carPicker.carId} style={{whiteSpace:'nowrap'}}>
                <I.IconPlus size={12}/> {t('presets.build_modal.add_slot')}
              </button>
            </div>

            {draft.slots.length > 0 && (
              <>
                <div className="row" style={{justifyContent:'flex-end', marginTop: 10}}>
                  <button className="btn btn-sm" onClick={clearSlots}>
                    <I.IconX size={11}/> {t('cars.btn_clear')}
                  </button>
                </div>
                <div style={{
                  marginTop: 8, maxHeight: 200, overflowY: 'auto',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                }}>
                  {draft.slots.map((slot, idx) => {
                    const c = cars.find(x => x.id === slot.id) || { id: slot.id, name: slot.id, brand: '' };
                    return (
                      <div key={idx} style={{display:'flex', alignItems:'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border)'}}>
                        <div className="muted mono" style={{fontSize: 10, width: 22, textAlign:'right', flexShrink:0}}>{idx + 1}</div>
                        <div style={{flex: 1, minWidth: 0}}>
                          <div style={{fontSize: 12.5, fontWeight: 500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{c.name || c.id}</div>
                          <div className="muted" style={{fontSize: 11, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
                            {slot.skin
                              ? <>{c.brand} · <span style={{color:'var(--text)'}}>{t('sess.skin')}: {slot.skin}</span></>
                              : c.brand}
                          </div>
                        </div>
                        <button className="icon-btn" style={{width: 24, height: 24}}
                          onClick={() => removeSlot(idx)}
                          title={t('common.delete')}>
                          <I.IconX size={12}/>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {draft.slots.length === 0 && (
              <div className="muted" style={{fontSize: 12, marginTop: 10}}>{t('presets.build_modal.no_cars_hint')}</div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={submit} disabled={!draft.name.trim() || !anyEnabled || busy}>
            <I.IconCheck size={13}/> {t('presets.save_modal.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

window.AppPagesContent = window.AppPagesContent || {};
window.AppPagesContent.PagePresets       = PagePresets;
window.AppPagesContent.SavePresetModal   = SavePresetModal;
window.AppPagesContent.BuildPresetModal  = BuildPresetModal;
