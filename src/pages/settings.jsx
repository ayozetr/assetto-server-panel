// Pages: Server configuration. Users / Profile / Audit live in sibling files
// (`users.jsx`, `profile.jsx`, `audit.jsx`); each pushes its component into
// the shared `window.AppPagesSettings` namespace. ConfirmModal stays here so
// other pages (logs.jsx) can read it via that namespace.
const { useState: useStateC, useEffect: useEffectC } = React;
const I4 = window.AppIcons;

// Country picker list. ISO2 + English name; backend writes the GEO_PARAMS.COUNTRY
// row as "<name>, <ISO2>" which is what Content Manager / acstuff lobby expects.
const COUNTRY_OPTIONS = [
  ['AR','Argentina'], ['AU','Australia'], ['AT','Austria'], ['BE','Belgium'],
  ['BR','Brazil'], ['BG','Bulgaria'], ['CA','Canada'], ['CL','Chile'],
  ['CN','China'], ['CO','Colombia'], ['HR','Croatia'], ['CZ','Czech Republic'],
  ['DK','Denmark'], ['EE','Estonia'], ['FI','Finland'], ['FR','France'],
  ['DE','Germany'], ['GR','Greece'], ['HK','Hong Kong'], ['HU','Hungary'],
  ['IS','Iceland'], ['IN','India'], ['IE','Ireland'], ['IL','Israel'],
  ['IT','Italy'], ['JP','Japan'], ['LV','Latvia'], ['LT','Lithuania'],
  ['LU','Luxembourg'], ['MY','Malaysia'], ['MX','Mexico'], ['MC','Monaco'],
  ['NL','Netherlands'], ['NZ','New Zealand'], ['NO','Norway'], ['PE','Peru'],
  ['PH','Philippines'], ['PL','Poland'], ['PT','Portugal'], ['RO','Romania'],
  ['RU','Russia'], ['SG','Singapore'], ['SK','Slovakia'], ['SI','Slovenia'],
  ['ZA','South Africa'], ['KR','South Korea'], ['ES','Spain'], ['SE','Sweden'],
  ['CH','Switzerland'], ['TW','Taiwan'], ['TH','Thailand'], ['TR','Turkey'],
  ['UA','Ukraine'], ['AE','United Arab Emirates'], ['GB','United Kingdom'],
  ['US','United States'], ['UY','Uruguay'], ['VE','Venezuela'], ['VN','Vietnam'],
];

function ConfirmModal({ title, message, onCancel, onConfirm }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  // Esc closes; backdrop click closes; click on dialog does not bubble.
  useEffectC(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body">
          <p style={{margin: 0, fontSize: 13, color: 'var(--text-muted)'}}>{message}</p>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={onConfirm} autoFocus style={{background: 'var(--red)', borderColor: 'var(--red)'}}>
            {t('users.del.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Upload limit card (independent from server_cfg.ini) ───────────────────────
function UploadLimitCard({ isAdmin }) {
  const t     = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k) => k;
  const toast = window.AppShell.useToast();
  const [maxMb,         setMaxMb]         = useStateC(500);
  const [chunkedUpload, setChunkedUpload] = useStateC(false);
  const [saving,        setSaving]        = useStateC(false);
  const [loaded,        setLoaded]        = useStateC(false);

  useEffectC(() => {
    fetch('/api/panel/settings')
      .then(r => r.json())
      .then(d => {
        if (d.uploadMaxMb) setMaxMb(d.uploadMaxMb);
        setChunkedUpload(!!d.chunkedUpload);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/panel/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadMaxMb: maxMb, chunkedUpload }),
      });
      const d = await r.json();
      if (d.ok) toast.push(t('config.upload_saved'), 'success');
      else toast.push(d.error || t('common.error'), 'error');
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card">
      <div className="card-header">
        <I4.IconUpload size={14} style={{color: 'var(--red)'}}/>
        <div className="card-title">{t('config.upload_title')}</div>
      </div>
      <div className="card-body col" style={{gap: 14}}>
        <div style={{display:'flex', alignItems:'flex-end', gap:10}}>
          <div style={{display:'flex', flexDirection:'column', gap:5, flex:1}}>
            <label className="field-label">{t('config.upload_limit')}</label>
            <input
              className="input mono"
              type="number" inputMode="numeric"
              min="1"
              max="10240"
              value={maxMb}
              onChange={e => setMaxMb(Number(e.target.value))}
              disabled={!isAdmin || !loaded}
            />
          </div>
          {isAdmin && (
            <button className="btn btn-primary btn-sm" style={{flexShrink:0, marginBottom:4}} onClick={save} disabled={saving || !loaded}>
              {saving
                ? <><I4.IconRefresh size={12} style={{animation:'spin 1s linear infinite'}}/> {t('common.saving')}</>
                : <><I4.IconCheck size={12}/> {t('common.apply')}</>}
            </button>
          )}
        </div>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:10}}>
          <div style={{display:'flex', flexDirection:'column', gap:3}}>
            <span className="field-label">{t('config.chunked_upload')}</span>
            <span className="field-hint">{t('config.chunked_upload_hint')}</span>
          </div>
          <div
            className={`switch ${chunkedUpload ? 'on' : ''}`}
            style={{flexShrink:0}}
            onClick={() => isAdmin && loaded && setChunkedUpload(v => !v)}
          />
        </div>
        <span className="field-hint">{t('config.upload_limit_hint')}</span>
        <div style={{
          padding: '8px 12px', borderRadius: 'var(--radius)',
          background: 'var(--bg-3)', fontSize: 12, color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <I4.IconShield size={13}/>
          {t('config.upload_security_note')}
        </div>
      </div>
    </div>
  );
}

function WhitelistEditor({ canManage }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell.useToast();
  const [ids,     setIds]     = useStateC([]);
  const [newId,   setNewId]   = useStateC('');
  const [saving,  setSaving]  = useStateC(false);
  const [loaded,  setLoaded]  = useStateC(false);

  useEffectC(() => {
    fetch('/api/whitelist').then(r => r.json())
      .then(d => { setIds(d.ids || []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  const addId = () => {
    const v = newId.trim();
    if (!/^\d{17}$/.test(v)) { toast.push(t('wl.invalid'), 'warn'); return; }
    if (ids.includes(v)) { toast.push(t('wl.exists'), 'info'); return; }
    setIds(prev => [...prev, v]);
    setNewId('');
  };

  const saveList = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/whitelist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const d = await r.json();
      if (d.ok) toast.push(t('wl.saved', { count: d.saved }), 'success');
      else toast.push(d.error || t('common.error'), 'error');
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{marginTop: 14}}>
      <div style={{fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8}}>
        {t('wl.title', { count: ids.length })}
      </div>
      {!loaded ? (
        <div style={{fontSize: 12, color: 'var(--text-faint)'}}>{t('common.loading')}</div>
      ) : ids.length === 0 ? (
        <div style={{fontSize: 12, color: 'var(--text-faint)', marginBottom: 8}}>{t('wl.empty')}</div>
      ) : (
        <div style={{maxHeight: 140, overflowY: 'auto', marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 4}}>
          {ids.map((id, i) => (
            <div key={id} style={{display:'flex', alignItems:'center', gap: 8, fontSize: 12}}>
              <span className="mono" style={{flex:1, color:'var(--text-muted)'}}>{id}</span>
              {canManage && (
                <button className="icon-btn" style={{width:20,height:20}} onClick={() => setIds(prev => prev.filter((_, j) => j !== i))}>
                  <I4.IconX size={11}/>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {canManage && (
        <div className="row" style={{gap: 6}}>
          <input className="input mono" placeholder="76561198000000000" value={newId}
            onChange={e=>setNewId(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&addId()}
            style={{flex:1, fontSize:12}}/>
          <button className="btn btn-sm" onClick={addId}><I4.IconPlus size={12}/> {t('common.add')}</button>
          <button className="btn btn-sm btn-primary" onClick={saveList} disabled={saving}>
            {saving ? t('common.saving') : <><I4.IconCheck size={12}/> {t('common.save')}</>}
          </button>
        </div>
      )}
    </div>
  );
}

function DiscordWebhookEditor({ canManage }) {
  const t     = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell.useToast();
  const [url,     setUrl]     = useStateC('');
  const [show,    setShow]    = useStateC(false);
  const [loaded,  setLoaded]  = useStateC(false);
  const [saving,  setSaving]  = useStateC(false);
  const [testing, setTesting] = useStateC(false);

  useEffectC(() => {
    fetch('/api/panel/settings')
      .then(r => r.json())
      .then(d => { setUrl(d.discordWebhook || ''); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/panel/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordWebhook: url }),
      });
      const d = await r.json();
      if (d.ok) {
        toast.push(t('config.discord_saved'), 'success');
        setShow(false);
      } else {
        toast.push(d.error || t('common.error'), 'error');
      }
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await fetch('/api/discord/webhook/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const d = await r.json();
      if (d.ok) toast.push(t('config.discord_test_ok'), 'success');
      else      toast.push(d.error || t('config.discord_test_fail'), 'error');
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setTesting(false); }
  };

  return (
    <div className="card" style={{gridColumn: 'span 2'}}>
      <div className="card-header">
        <I4.IconDiscord size={14} style={{color: 'var(--red)'}}/>
        <div className="card-title">{t('config.discord_title')}</div>
      </div>
      <div className="card-body col" style={{gap: 10}}>
        <div className="field">
          <label className="field-label">{t('config.discord_webhook')}</label>
          <span className="field-hint" style={{marginBottom: 6}}>{t('config.discord_webhook_hint')}</span>
          <div style={{position:'relative'}}>
            <input
              className="input mono"
              type={show ? 'text' : 'password'}
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              disabled={!canManage || !loaded}
              spellCheck={false}
              autoComplete="off"
              style={{paddingRight: 36, fontSize: 12}}
            />
            <button
              type="button"
              onClick={() => setShow(v => !v)}
              title={show ? t('common.hide') || 'Hide' : t('common.show') || 'Show'}
              disabled={!canManage || !loaded}
              style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}
            >
              {show ? <I4.IconEyeOff size={14}/> : <I4.IconEye size={14}/>}
            </button>
          </div>
        </div>
        {canManage && (
          <div className="row" style={{gap: 6, justifyContent: 'flex-end'}}>
            <button className="btn btn-sm" onClick={test} disabled={!loaded || testing || saving || !url}>
              {testing
                ? <><I4.IconRefresh size={12} style={{animation:'spin 1s linear infinite'}}/> {t('config.discord_testing')}</>
                : <><I4.IconBell size={12}/> {t('config.discord_test')}</>}
            </button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={!loaded || saving || testing}>
              {saving
                ? <><I4.IconRefresh size={12} style={{animation:'spin 1s linear infinite'}}/> {t('common.saving')}</>
                : <><I4.IconCheck size={12}/> {t('common.save')}</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PasswordField({ value, onChange, disabled, placeholder }) {
  const [show, setShow] = useStateC(false);
  return (
    <div style={{position:'relative'}}>
      <input
        className="input"
        type={show ? 'text' : 'password'}
        value={value || ''}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        style={{paddingRight: 36}}
      />
      <button
        type="button"
        onClick={() => setShow(v => !v)}
        title={show ? 'Hide' : 'Show'}
        style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}
      >
        {show ? <I4.IconEyeOff size={14}/> : <I4.IconEye size={14}/>}
      </button>
    </div>
  );
}

function PageConfig({ config, setConfig, isAdmin, perms = {}, canEdit = isAdmin, onSave }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [dirty,  setDirty]  = useStateC(false);
  const [saving, setSaving] = useStateC(false);
  const set = (k, v) => { setConfig(c => ({...c, [k]: v})); setDirty(true); };
  const canManageWhitelist = isAdmin || !!perms.whitelistManage;
  const canManageDiscord   = isAdmin || !!perms.discordWebhook;

  const save = async (opts) => {
    setSaving(true);
    try { await onSave(opts); setDirty(false); }
    catch {} // toast already raised by caller
    finally { setSaving(false); }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('config.title')}</h1>
        <p className="page-sub">{t('config.sub')}</p>
      </div>

      {!canEdit && (
        <div className="card" style={{marginBottom: 16, padding: '12px 16px', background: 'var(--bg-3)', display:'flex', alignItems:'center', gap: 10}}>
          <I4.IconLock size={14} style={{color: 'var(--text-muted)'}}/>
          <span style={{fontSize: 13, color: 'var(--text-muted)'}}>{t('config.admin_only')}</span>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <I4.IconUser size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('config.identity')}</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="field">
              <label className="field-label">{t('config.name')}</label>
              <input className="input" value={config.name} onChange={e=>set('name', e.target.value)} disabled={!canEdit}/>
            </div>
            <div className="field">
              <label className="field-label">{t('config.welcome')}</label>
              <input className="input" value={config.welcome} onChange={e=>set('welcome', e.target.value)} disabled={!canEdit}/>
              <span className="field-hint">{t('config.welcome_hint') || 'Newlines are not preserved by Assetto Corsa.'}</span>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">{t('config.country')}</label>
                <select
                  className="select"
                  value={config.countryIso || ''}
                  disabled={!canEdit}
                  onChange={e => {
                    const iso = e.target.value;
                    const opt = COUNTRY_OPTIONS.find(([code]) => code === iso);
                    setConfig(c => ({ ...c, countryIso: iso, country: opt ? opt[1] : '' }));
                    setDirty(true);
                  }}
                >
                  <option value="">{t('config.country_none')}</option>
                  {COUNTRY_OPTIONS.map(([code, name]) => (
                    <option key={code} value={code}>{name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label">{t('config.city')}</label>
                <input
                  className="input" maxLength={64}
                  value={config.city || ''}
                  onChange={e=>set('city', e.target.value)}
                  disabled={!canEdit}
                />
              </div>
            </div>
            <div className="row-between">
              <div>
                <div style={{fontSize: 13, fontWeight: 500}}>{t('config.public')}</div>
                <div className="muted" style={{fontSize: 11.5}}>{t('config.public_sub')}</div>
              </div>
              <div className={`switch ${config.publicLobby ? 'on' : ''}`} onClick={()=>canEdit && set('publicLobby', !config.publicLobby)}></div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <I4.IconLink size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('config.network')}</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">{t('config.tcp')}</label>
                <input className="input mono" type="number" inputMode="numeric" value={config.tcp} onChange={e=>set('tcp', Number(e.target.value))} disabled={!canEdit}/>
              </div>
              <div className="field">
                <label className="field-label">{t('config.udp')}</label>
                <input className="input mono" type="number" inputMode="numeric" value={config.udp} onChange={e=>set('udp', Number(e.target.value))} disabled={!canEdit}/>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">{t('config.http')}</label>
                <input className="input mono" type="number" inputMode="numeric" value={config.http} onChange={e=>set('http', Number(e.target.value))} disabled={!canEdit}/>
              </div>
              <div className="field">
                <label className="field-label">{t('config.tickrate')}</label>
                <input className="input mono" type="number" inputMode="numeric" value={config.tickrate} onChange={e=>set('tickrate', Number(e.target.value))} disabled={!canEdit}/>
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t('config.max_clients')}</label>
              <input className="input mono" type="number" inputMode="numeric" min="1" max="200" value={config.maxClients ?? 16} onChange={e=>set('maxClients', Number(e.target.value))} disabled={!canEdit}/>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <I4.IconLock size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('config.access')}</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="field">
              <label className="field-label">{t('config.pass')}</label>
              <PasswordField value={config.password} onChange={e=>set('password', e.target.value)} placeholder={t('config.pass_empty')} disabled={!isAdmin}/>
              <span className="field-hint">{t('config.pass_hint')}</span>
            </div>
            <div className="field">
              <label className="field-label">{t('config.admin_pass')}</label>
              <PasswordField value={config.adminPass} onChange={e=>set('adminPass', e.target.value)} disabled={!isAdmin}/>
            </div>
            <div className="row-between">
              <div>
                <div style={{fontSize: 13, fontWeight: 500}}>{t('config.whitelist')}</div>
                <div className="muted" style={{fontSize: 11.5}}>{t('config.whitelist_sub')}</div>
              </div>
              <div className={`switch ${config.whitelist ? 'on' : ''}`} onClick={()=>canManageWhitelist && set('whitelist', !config.whitelist)}></div>
            </div>
            {config.whitelist && <WhitelistEditor canManage={canManageWhitelist}/>}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <I4.IconFlag size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('config.rules')}</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">{t('config.fuel')}</label>
                <input className="input mono" type="number" inputMode="numeric" min="0" max="200" value={config.fuelRate ?? 100} onChange={e=>set('fuelRate', Number(e.target.value))} disabled={!canEdit}/>
                <span className="field-hint">{t('config.fuel_hint')}</span>
              </div>
              <div className="field">
                <label className="field-label">{t('config.damage')}</label>
                <input className="input mono" type="number" inputMode="numeric" min="0" max="200" value={config.damage ?? 100} onChange={e=>set('damage', Number(e.target.value))} disabled={!canEdit}/>
              </div>
              <div className="field" style={{gridColumn: 'span 2'}}>
                <label className="field-label">{t('config.tyres')}</label>
                <input className="input mono" type="number" inputMode="numeric" min="0" max="200" value={config.tyreWear ?? 100} onChange={e=>set('tyreWear', Number(e.target.value))} disabled={!canEdit}/>
              </div>
              <div className="field">
                <label className="field-label">{t('config.abs')}</label>
                <span className="field-hint" style={{marginBottom: 4}}>{t('config.abs_sub')}</span>
                <select className="select" style={{width: '100%'}} value={config.abs ?? 0} onChange={e=>canEdit && set('abs', Number(e.target.value))} disabled={!canEdit}>
                  <option value={0}>{t('config.opt_no')}</option>
                  <option value={1}>{t('config.opt_factory')}</option>
                  <option value={2}>{t('config.opt_free')}</option>
                </select>
              </div>
              <div className="field">
                <label className="field-label">{t('config.tc')}</label>
                <span className="field-hint" style={{marginBottom: 4}}>{t('config.tc_sub')}</span>
                <select className="select" style={{width: '100%'}} value={config.tc ?? 0} onChange={e=>canEdit && set('tc', Number(e.target.value))} disabled={!canEdit}>
                  <option value={0}>{t('config.opt_no')}</option>
                  <option value={1}>{t('config.opt_factory')}</option>
                  <option value={2}>{t('config.opt_free')}</option>
                </select>
              </div>
            </div>
            <div className="col" style={{gap: 12}}>
              <div className="row-between">
                <div style={{fontSize: 13, fontWeight: 500}}>{t('config.autoclutch')}</div>
                <div className={`switch ${config.autoclutch ? 'on' : ''}`} onClick={()=>canEdit && set('autoclutch', !config.autoclutch)}></div>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.stability')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{t('config.stability_sub')}</div>
                </div>
                <div className={`switch ${config.stability ? 'on' : ''}`} onClick={()=>canEdit && set('stability', !config.stability)}></div>
              </div>
            </div>
          </div>
        </div>

        <DiscordWebhookEditor canManage={canManageDiscord}/>

        <div className="card">
          <div className="card-header">
            <I4.IconSettings size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('config.behavior')}</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="grid-2">
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.autostart')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{t('config.autostart_sub')}</div>
                </div>
                <div className={`switch ${config.autoStart ? 'on' : ''}`} onClick={()=>canEdit && set('autoStart', !config.autoStart)}></div>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.autorestart')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{t('config.autorestart_sub')}</div>
                </div>
                <div className={`switch ${config.autoRestart ? 'on' : ''}`} onClick={()=>canEdit && set('autoRestart', !config.autoRestart)}></div>
              </div>
              <div className="field" style={{gridColumn: 'span 2'}}>
                <label className="field-label">{t('config.lang')}</label>
                <span className="field-hint" style={{marginBottom: 6}}>{t('config.lang_sub')}</span>
                <select className="select" style={{width: '100%'}} value={window.AppI18n ? window.AppI18n.lang : 'en'} onChange={e => {
                  const l = e.target.value;
                  if (window.AppI18n) window.AppI18n.setLang(l);
                  fetch('/api/panel/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lang: l }),
                  }).catch(() => {});
                }}>
                  <option value="en">English</option>
                  <option value="es">Español</option>
                  <option value="it">Italiano</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <UploadLimitCard isAdmin={isAdmin}/>
      </div>

      {canEdit && (
        <div className="row" style={{marginTop: 20, justifyContent: 'flex-end', gap: 8, position:'sticky', bottom: 16, background:'var(--bg-2)', padding:'10px 0'}}>
          {dirty && !saving && <span className="badge badge-amber">{t('config.unsaved')}</span>}
          <button className="btn" onClick={()=>setDirty(false)} disabled={saving}>{t('common.cancel')}</button>
          <button className="btn" onClick={()=>save({ restart: false })} disabled={!dirty || saving}>
            {saving
              ? <><I4.IconRefresh size={13} style={{animation:'spin 1s linear infinite'}}/> {t('common.saving')}</>
              : <><I4.IconCheck size={13}/> {t('common.save')}</>}
          </button>
          {(isAdmin || perms.serverControl) && (
            <button className="btn btn-primary" onClick={()=>save({ restart: true })} disabled={!dirty || saving}>
              {saving
                ? <><I4.IconRefresh size={13} style={{animation:'spin 1s linear infinite'}}/> {t('common.saving')}</>
                : <><I4.IconPower size={13}/> {t('config.save_and_restart') || 'Guardar y reiniciar'}</>}
            </button>
          )}
        </div>
      )}
    </>
  );
}

window.AppPagesSettings = window.AppPagesSettings || {};
window.AppPagesSettings.PageConfig    = PageConfig;
window.AppPagesSettings.ConfirmModal  = ConfirmModal;
