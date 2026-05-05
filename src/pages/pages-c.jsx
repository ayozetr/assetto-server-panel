// Pages: Config, Users, Profile
const { useState: useStateC, useEffect: useEffectC } = React;
const I4 = window.AppIcons;

// ── Upload limit card (independent from server_cfg.ini) ───────────────────────
function UploadLimitCard({ isAdmin }) {
  const t     = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k) => k;
  const toast = window.AppShell.useToast();
  const [maxMb,   setMaxMb]   = useStateC(500);
  const [saving,  setSaving]  = useStateC(false);
  const [loaded,  setLoaded]  = useStateC(false);

  useEffectC(() => {
    fetch('/api/panel/settings')
      .then(r => r.json())
      .then(d => { if (d.uploadMaxMb) setMaxMb(d.uploadMaxMb); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/panel/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadMaxMb: maxMb }),
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
              type="number"
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

function WhitelistEditor({ isAdmin }) {
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
              {isAdmin && (
                <button className="icon-btn" style={{width:20,height:20}} onClick={() => setIds(prev => prev.filter((_, j) => j !== i))}>
                  <I4.IconX size={11}/>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {isAdmin && (
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

function PageConfig({ config, setConfig, isAdmin, onSave }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast  = window.AppShell.useToast();
  const [dirty,  setDirty]  = useStateC(false);
  const [saving, setSaving] = useStateC(false);
  const set = (k, v) => { setConfig(c => ({...c, [k]: v})); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try { await onSave(); setDirty(false); }
    catch { toast.push(t('common.error'), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('config.title')}</h1>
        <p className="page-sub">{t('config.sub')}</p>
      </div>

      {!isAdmin && (
        <div className="card" style={{marginBottom: 16, padding: '12px 16px', background: 'var(--bg-3)', display:'flex', alignItems:'center', gap: 10}}>
          <I4.IconLock size={14} style={{color: 'var(--text-muted)'}}/>
          <span style={{fontSize: 13, color: 'var(--text-muted)'}}>{t('config.admin_only')}</span>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div className="card-title">{t('config.identity')}</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="field">
              <label className="field-label">{t('config.name')}</label>
              <input className="input" value={config.name} onChange={e=>set('name', e.target.value)} disabled={!isAdmin}/>
            </div>
            <div className="field">
              <label className="field-label">{t('config.welcome')}</label>
              <input className="input" value={config.welcome} onChange={e=>set('welcome', e.target.value)} disabled={!isAdmin}/>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">{t('config.network')}</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">{t('config.tcp')}</label>
                <input className="input mono" type="number" value={config.tcp} onChange={e=>set('tcp', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
              <div className="field">
                <label className="field-label">{t('config.udp')}</label>
                <input className="input mono" type="number" value={config.udp} onChange={e=>set('udp', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">{t('config.http')}</label>
                <input className="input mono" type="number" value={config.http} onChange={e=>set('http', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
              <div className="field">
                <label className="field-label">{t('config.tickrate')}</label>
                <input className="input mono" type="number" value={config.tickrate} onChange={e=>set('tickrate', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t('config.max_clients')}</label>
              <input className="input mono" type="number" min="1" max="200" value={config.maxClients ?? 16} onChange={e=>set('maxClients', Number(e.target.value))} disabled={!isAdmin}/>
            </div>
            <div className="row-between">
              <div>
                <div style={{fontSize: 13, fontWeight: 500}}>{t('config.public')}</div>
                <div className="muted" style={{fontSize: 11.5}}>{t('config.public_sub')}</div>
              </div>
              <div className={`switch ${config.publicLobby ? 'on' : ''}`} onClick={()=>isAdmin && set('publicLobby', !config.publicLobby)}></div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">{t('config.access')}</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="field">
              <label className="field-label">{t('config.pass')}</label>
              <input className="input" type="password" value={config.password} onChange={e=>set('password', e.target.value)} placeholder={t('config.pass_empty')} disabled={!isAdmin}/>
              <span className="field-hint">{t('config.pass_hint')}</span>
            </div>
            <div className="field">
              <label className="field-label">{t('config.admin_pass')}</label>
              <input className="input" type="password" value={config.adminPass} onChange={e=>set('adminPass', e.target.value)} disabled={!isAdmin}/>
            </div>
            <div className="row-between">
              <div>
                <div style={{fontSize: 13, fontWeight: 500}}>{t('config.whitelist')}</div>
                <div className="muted" style={{fontSize: 11.5}}>{t('config.whitelist_sub')}</div>
              </div>
              <div className={`switch ${config.whitelist ? 'on' : ''}`} onClick={()=>isAdmin && set('whitelist', !config.whitelist)}></div>
            </div>
            {config.whitelist && <WhitelistEditor isAdmin={isAdmin}/>}
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
                <input className="input mono" type="number" min="0" max="200" value={config.fuelRate ?? 100} onChange={e=>set('fuelRate', Number(e.target.value))} disabled={!isAdmin}/>
                <span className="field-hint">{t('config.fuel_hint')}</span>
              </div>
              <div className="field">
                <label className="field-label">{t('config.damage')}</label>
                <input className="input mono" type="number" min="0" max="200" value={config.damage ?? 100} onChange={e=>set('damage', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
              <div className="field" style={{gridColumn: 'span 2'}}>
                <label className="field-label">{t('config.tyres')}</label>
                <input className="input mono" type="number" min="0" max="200" value={config.tyreWear ?? 100} onChange={e=>set('tyreWear', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
            </div>
            <div className="grid-2">
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.abs')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{t('config.abs_sub')}</div>
                </div>
                <select className="select" style={{width: 110}} value={config.abs ?? 0} onChange={e=>isAdmin && set('abs', Number(e.target.value))} disabled={!isAdmin}>
                  <option value={0}>{t('config.opt_no')}</option>
                  <option value={1}>{t('config.opt_factory')}</option>
                  <option value={2}>{t('config.opt_free')}</option>
                </select>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.tc')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{t('config.tc_sub')}</div>
                </div>
                <select className="select" style={{width: 110}} value={config.tc ?? 0} onChange={e=>isAdmin && set('tc', Number(e.target.value))} disabled={!isAdmin}>
                  <option value={0}>{t('config.opt_no')}</option>
                  <option value={1}>{t('config.opt_factory')}</option>
                  <option value={2}>{t('config.opt_free')}</option>
                </select>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.autoclutch')}</div>
                </div>
                <div className={`switch ${config.autoclutch ? 'on' : ''}`} onClick={()=>isAdmin && set('autoclutch', !config.autoclutch)}></div>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.stability')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{t('config.stability_sub')}</div>
                </div>
                <div className={`switch ${config.stability ? 'on' : ''}`} onClick={()=>isAdmin && set('stability', !config.stability)}></div>
              </div>
            </div>
          </div>
        </div>

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
                <div className={`switch ${config.autoStart ? 'on' : ''}`} onClick={()=>isAdmin && set('autoStart', !config.autoStart)}></div>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.autorestart')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{t('config.autorestart_sub')}</div>
                </div>
                <div className={`switch ${config.autoRestart ? 'on' : ''}`} onClick={()=>isAdmin && set('autoRestart', !config.autoRestart)}></div>
              </div>
              <div className="row-between" style={{gridColumn: 'span 2'}}>
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>{t('config.lang')}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{t('config.lang_sub')}</div>
                </div>
                <select className="select" style={{width: 110}} value={window.AppI18n ? window.AppI18n.lang : 'en'} onChange={e=>window.AppI18n && window.AppI18n.setLang(e.target.value)}>
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

      {isAdmin && (
        <div className="row" style={{marginTop: 20, justifyContent: 'flex-end', gap: 8, position:'sticky', bottom: 16, background:'var(--bg-2)', padding:'10px 0'}}>
          {dirty && !saving && <span className="badge badge-amber">{t('config.unsaved')}</span>}
          <button className="btn" onClick={()=>setDirty(false)} disabled={saving}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving
              ? <><I4.IconRefresh size={13} style={{animation:'spin 1s linear infinite'}}/> {t('common.saving')}</>
              : <><I4.IconCheck size={13}/> {t('common.save')}</>}
          </button>
        </div>
      )}
    </>
  );
}

function PageUsers({ users, setUsers, isAdmin }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast      = window.AppShell.useToast();
  const [editing,    setEditing]    = useStateC(null);
  const [confirmDel, setConfirmDel] = useStateC(null);

  const loadUsers = () => {
    fetch('/api/panel/users')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setUsers(d); })
      .catch(() => {});
  };

  useEffectC(() => { loadUsers(); }, []);

  if (!isAdmin) {
    return (
      <>
        <div className="page-header"><h1 className="page-title">{t('users.title')}</h1></div>
        <div className="card">
          <div className="empty">
            <I4.IconLock size={20} style={{display:'block', margin:'0 auto 10px'}}/>
            {t('users.admin_only')}
          </div>
        </div>
      </>
    );
  }

  const saveUser = async (form) => {
    try {
      let r;
      if (form.id) {
        r = await fetch(`/api/panel/users/${encodeURIComponent(form.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: form.role, password: form.password || undefined }),
        });
      } else {
        if (!form.password || form.password.length < 8) {
          toast.push(t('users.pw_len'), 'error'); return;
        }
        r = await fetch('/api/panel/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: form.name, password: form.password, role: form.role }),
        });
      }
      const d = await r.json();
      if (d.error) { toast.push(d.error, 'error'); return; }
      toast.push(form.id ? t('users.updated') : t('users.created'), 'success');
      setEditing(null);
      loadUsers();
    } catch { toast.push(t('common.net_error'), 'error'); }
  };

  const deleteUser = async (u) => {
    try {
      await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' });
      toast.push(t('users.deleted', { name: u.name }), 'success');
      setConfirmDel(null);
      loadUsers();
    } catch { toast.push(t('common.error'), 'error'); }
  };

  return (
    <>
      <div className="page-header row-between">
        <div>
          <h1 className="page-title">{t('users.title')}</h1>
          <p className="page-sub">{users.length} {t('users.sub')}</p>
        </div>
        <button className="btn btn-primary" onClick={()=>setEditing({ name: '', role: 'user', password: '' })}>
          <I4.IconPlus size={13}/> {t('users.new')}
        </button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>{t('users.col.user')}</th>
              <th>{t('users.col.role')}</th>
              <th>{t('users.col.created')}</th>
              <th style={{width: 90}}></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td>
                  <div className="row" style={{gap: 10}}>
                    <div className="user-avatar" style={{width: 28, height: 28, fontSize: 11}}>
                      {u.name.slice(0,1).toUpperCase()}
                    </div>
                    <div className="player-name">{u.name}</div>
                  </div>
                </td>
                <td>
                  {u.role === 'admin'
                    ? <span className="badge badge-red"><I4.IconShield size={10}/> Admin</span>
                    : <span className="badge">{t('sidebar.role.user')}</span>}
                </td>
                <td className="muted mono" style={{fontSize: 12}}>{u.created}</td>
                <td>
                  <div className="row" style={{gap: 4}}>
                    <button className="icon-btn" onClick={()=>setEditing(u)} title={t('common.edit')}><I4.IconEdit size={14}/></button>
                    <button className="icon-btn" onClick={()=>setConfirmDel(u)} title={t('common.delete')}><I4.IconTrash size={14}/></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <UserModal user={editing} onClose={()=>setEditing(null)} onSave={saveUser}/>}
      {confirmDel && (
        <ConfirmModal
          title={t('users.del.title', { name: confirmDel.name })}
          message={t('users.del.msg')}
          onCancel={()=>setConfirmDel(null)}
          onConfirm={()=>deleteUser(confirmDel)}
        />
      )}
    </>
  );
}

function UserModal({ user, onClose, onSave }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [form,    setForm]    = useStateC({ ...user, password: '' });
  const [pwError, setPwError] = useStateC('');
  const set = (k, v) => setForm(f => ({...f, [k]: v}));
  const valid = form.name.trim().length > 0;
  const submit = () => {
    if (!user.id && !form.password) { setPwError(t('users.pw_req')); return; }
    if (form.password && form.password.length < 8) { setPwError(t('users.pw_len')); return; }
    setPwError('');
    onSave(form);
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header">
          <I4.IconUser size={15}/>
          <div className="modal-title">{user.id ? t('users.modal.title_edit') : t('users.modal.title_new')}</div>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">{t('users.modal.name')}</label>
            <input className="input" value={form.name} onChange={e=>set('name', e.target.value)} disabled={!!user.id}/>
            {user.id && <span className="field-hint">{t('users.modal.name_hint')}</span>}
          </div>
          <div className="field">
            <label className="field-label">{t('users.modal.role')}</label>
            <div className="segmented" style={{alignSelf:'flex-start'}}>
              <button className={form.role === 'user' ? 'active' : ''} onClick={()=>set('role', 'user')}>{t('users.modal.role.user')}</button>
              <button className={form.role === 'admin' ? 'active' : ''} onClick={()=>set('role', 'admin')}>{t('users.modal.role.admin')}</button>
            </div>
          </div>
          <div className="field">
            <label className="field-label">{user.id ? t('users.modal.pw_edit') : t('users.modal.pw')}</label>
            <input className="input" type="password" value={form.password} onChange={e=>set('password', e.target.value)}
              placeholder={user.id ? '' : '••••••••'}/>
            {pwError && <span className="field-hint" style={{color:'var(--red)'}}>{pwError}</span>}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!valid} onClick={submit}>
            <I4.IconCheck size={13}/> {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, onCancel, onConfirm }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body">
          <p style={{margin: 0, fontSize: 13, color: 'var(--text-muted)'}}>{message}</p>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={onConfirm} style={{background: 'var(--red)', borderColor: 'var(--red)'}}>
            {t('users.del.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Profile / Change password ─────────────────────────────────────────────────
function PageProfile({ user }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell.useToast();

  const [currentPw,  setCurrentPw]  = useStateC('');
  const [newPw,      setNewPw]      = useStateC('');
  const [confirmPw,  setConfirmPw]  = useStateC('');
  const [showCurrent,setShowCurrent]= useStateC(false);
  const [showNew,    setShowNew]    = useStateC(false);
  const [saving,     setSaving]     = useStateC(false);
  const [formError,  setFormError]  = useStateC('');

  const [genLength,  setGenLength]  = useStateC(16);
  const [genSpecial, setGenSpecial] = useStateC(true);
  const [generated,  setGenerated]  = useStateC('');

  const buildPassword = (length, special) => {
    const lower   = 'abcdefghijklmnopqrstuvwxyz';
    const upper   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits  = '0123456789';
    const specials = '!@#$%^&*()_+-=[]{}|;:,.?';
    const pool = lower + upper + digits + (special ? specials : '');
    let pwd = lower[Math.floor(Math.random() * lower.length)]
            + upper[Math.floor(Math.random() * upper.length)]
            + digits[Math.floor(Math.random() * digits.length)];
    if (special) pwd += specials[Math.floor(Math.random() * specials.length)];
    while (pwd.length < length) pwd += pool[Math.floor(Math.random() * pool.length)];
    const arr = pwd.split('');
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.join('');
  };

  const generatePassword = () => setGenerated(buildPassword(genLength, genSpecial));

  useEffectC(() => { setGenerated(buildPassword(genLength, genSpecial)); }, [genLength, genSpecial]);

  const copyPassword = () => {
    if (!generated) return;
    navigator.clipboard.writeText(generated).then(
      () => toast.push(t('profile.copied'), 'success'),
      () => toast.push(t('profile.copy_fail'), 'warn')
    );
  };

  const useGeneratedPassword = () => {
    if (!generated) return;
    setNewPw(generated);
    setConfirmPw(generated);
    toast.push(t('profile.inserted'), 'info');
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setFormError('');
    if (!currentPw || !newPw || !confirmPw) { setFormError(t('profile.err_req')); return; }
    if (newPw !== confirmPw) { setFormError(t('profile.err_match')); return; }
    if (newPw.length < 8) { setFormError(t('profile.err_len')); return; }
    if (newPw === currentPw) { setFormError(t('profile.err_diff')); return; }
    setSaving(true);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.name, currentPassword: currentPw, newPassword: newPw }),
      });
      const d = await r.json();
      if (d.ok) {
        toast.push(t('profile.pw_updated'), 'success');
        setCurrentPw(''); setNewPw(''); setConfirmPw('');
      } else {
        setFormError(d.error || t('common.error'));
      }
    } catch {
      setFormError(t('common.net_error'));
    } finally {
      setSaving(false);
    }
  };

  const eyeBtn = (show, toggle) => (
    <button type="button" onClick={toggle}
      style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}
    >
      {show ? <I4.IconEyeOff size={14}/> : <I4.IconEye size={14}/>}
    </button>
  );

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{t('profile.title')}</h1>
        <p className="page-sub">{t('profile.sub')}</p>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <I4.IconKey size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('profile.change_pw')}</div>
          </div>
          <form className="card-body col" style={{gap:14}} onSubmit={handleSubmit}>
            <div className="field">
              <label className="field-label">{t('profile.cur_pw')}</label>
              <div style={{position:'relative'}}>
                <input className="input" type={showCurrent ? 'text' : 'password'}
                  value={currentPw} onChange={e=>setCurrentPw(e.target.value)}
                  placeholder="••••••••" style={{paddingRight:36}}/>
                {eyeBtn(showCurrent, () => setShowCurrent(v=>!v))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t('profile.new_pw')}</label>
              <div style={{position:'relative'}}>
                <input className="input" type={showNew ? 'text' : 'password'}
                  value={newPw} onChange={e=>setNewPw(e.target.value)}
                  placeholder="••••••••" style={{paddingRight:36}}/>
                {eyeBtn(showNew, () => setShowNew(v=>!v))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">{t('profile.confirm_pw')}</label>
              <input className="input" type="password"
                value={confirmPw} onChange={e=>setConfirmPw(e.target.value)}
                placeholder="••••••••"/>
            </div>
            {formError && <div style={{fontSize:12,color:'var(--red)'}}>{formError}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving} style={{alignSelf:'flex-start'}}>
              <I4.IconCheck size={13}/> {saving ? t('common.saving') : t('profile.change_pw')}
            </button>
          </form>
        </div>

        <div className="card">
          <div className="card-header">
            <I4.IconRefresh size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">{t('profile.gen_title')}</div>
          </div>
          <div className="card-body col" style={{gap:14}}>
            <div className="field">
              <label className="field-label">{t('profile.len')} <strong>{genLength}</strong> {t('profile.chars')}</label>
              <input type="range" min="8" max="24" value={genLength}
                onChange={e=>setGenLength(Number(e.target.value))}
                style={{width:'100%',accentColor:'var(--red)',cursor:'pointer'}}/>
              <div className="row-between" style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>
                <span>8</span><span>16</span><span>24</span>
              </div>
            </div>

            <div className="row-between">
              <div>
                <div style={{fontSize:13,fontWeight:500}}>{t('profile.specials')}</div>
                <div className="muted" style={{fontSize:11.5}}>!@#$%^&amp;*()_+-=[]{}|</div>
              </div>
              <div className={`switch ${genSpecial ? 'on' : ''}`} onClick={()=>setGenSpecial(v=>!v)}></div>
            </div>

            <div className="field">
              <label className="field-label">{t('profile.generated')}</label>
              <div style={{display:'flex',gap:6,alignItems:'center'}}>
                <div style={{flex:1,position:'relative'}}>
                  <div className="input mono" style={{padding:'7px 36px 7px 10px',background:'var(--bg-3)',wordBreak:'break-all',fontSize:12,userSelect:'all',minHeight:34,display:'flex',alignItems:'center'}}>
                    {generated || '…'}
                  </div>
                  <button type="button" onClick={generatePassword} title="Regenerar"
                    style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:0,display:'flex',alignItems:'center'}}
                  >
                    <I4.IconRefresh size={14}/>
                  </button>
                </div>
                <button type="button" className="icon-btn" onClick={copyPassword} title={t('profile.copy')}>
                  <I4.IconCopy size={14}/>
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={useGeneratedPassword}>
                  {t('profile.use')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

window.AppPagesC = { PageConfig, PageUsers, PageProfile, ConfirmModal };
