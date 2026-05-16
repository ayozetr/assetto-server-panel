// Page: Users CRUD + the modal that backs Create/Edit. Split out of
// settings.jsx for size. Reads ConfirmModal from the settings namespace
// (settings.jsx loads first; the alias resolves at IIFE-evaluation time).
const { useState: useStateU, useEffect: useEffectU } = React;
const I4U = window.AppIcons;
const ConfirmModal = window.AppPagesSettings.ConfirmModal;

function UserModal({ user, onClose, onSave }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const [form,    setForm]    = useStateU({ ...user, password: '' });
  const [pwError, setPwError] = useStateU('');
  const set = (k, v) => setForm(f => ({...f, [k]: v}));
  const valid = form.name.trim().length > 0;
  const submit = () => {
    if (!user.id && !form.password) { setPwError(t('users.pw_req')); return; }
    if (form.password && form.password.length < 8) { setPwError(t('users.pw_len')); return; }
    setPwError('');
    onSave(form);
  };
  const trapRef = window.AppShell.useFocusTrap ? window.AppShell.useFocusTrap(true) : { current: null };
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={trapRef} className="modal" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label={user.id ? t('users.modal.title_edit') : t('users.modal.title_new')} tabIndex={-1}>
        <div className="modal-header">
          <I4U.IconUser size={15}/>
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
            <I4U.IconCheck size={13}/> {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PageUsers({ users, setUsers, isAdmin }) {
  const t = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast      = window.AppShell.useToast();
  const [editing,    setEditing]    = useStateU(null);
  const [confirmDel, setConfirmDel] = useStateU(null);

  const loadUsers = () => {
    fetch('/api/panel/users')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setUsers(d); })
      .catch(() => {});
  };

  useEffectU(() => { loadUsers(); }, []);

  if (!isAdmin) {
    return (
      <>
        <div className="page-header"><h1 className="page-title">{t('users.title')}</h1></div>
        <div className="card">
          <div className="empty">
            <I4U.IconLock size={20} style={{display:'block', margin:'0 auto 10px'}}/>
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
          <I4U.IconPlus size={13}/> {t('users.new')}
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
                      {(u.name || '?').slice(0,1).toUpperCase()}
                    </div>
                    <div className="player-name">{u.name || '—'}</div>
                  </div>
                </td>
                <td>
                  {u.role === 'admin'
                    ? <span className="badge badge-red"><I4U.IconShield size={10}/> Admin</span>
                    : <span className="badge">{t('sidebar.role.user')}</span>}
                </td>
                <td className="muted mono" style={{fontSize: 12}}>{u.created}</td>
                <td>
                  <div className="row" style={{gap: 4}}>
                    <button className="icon-btn" onClick={()=>setEditing(u)} title={t('common.edit')}><I4U.IconEdit size={14}/></button>
                    <button className="icon-btn" onClick={()=>setConfirmDel(u)} title={t('common.delete')}><I4U.IconTrash size={14}/></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <RolePermissionsCard/>

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

// Canonical list, matches ROLE_PERMISSIONS in server.js. Each entry maps the
// permission key to its UI label/hint i18n keys. If the order or content here
// drifts from the backend the page just hides whatever isn't returned.
const PERMISSION_DEFS = [
  { key: 'serverControl',    label: 'perm.serverControl',    hint: 'perm.serverControl_hint' },
  { key: 'sessionEdit',      label: 'perm.sessionEdit',      hint: 'perm.sessionEdit_hint' },
  { key: 'serverConfig',     label: 'perm.serverConfig',     hint: 'perm.serverConfig_hint' },
  { key: 'whitelistManage',  label: 'perm.whitelistManage',  hint: 'perm.whitelistManage_hint' },
  { key: 'playerModeration', label: 'perm.playerModeration', hint: 'perm.playerModeration_hint' },
  { key: 'modUpload',        label: 'perm.modUpload',        hint: 'perm.modUpload_hint' },
  { key: 'discordWebhook',   label: 'perm.discordWebhook',   hint: 'perm.discordWebhook_hint' },
  { key: 'auditView',        label: 'perm.auditView',        hint: 'perm.auditView_hint' },
  { key: 'dbBackup',         label: 'perm.dbBackup',         hint: 'perm.dbBackup_hint' },
];

function RolePermissionsCard() {
  const t     = window.AppI18n ? window.AppI18n.t.bind(window.AppI18n) : (k)=>k;
  const toast = window.AppShell.useToast();
  const [perms,   setPerms]   = useStateU(null);
  const [saving,  setSaving]  = useStateU(false);
  const [dirty,   setDirty]   = useStateU(false);

  useEffectU(() => {
    fetch('/api/permissions/role')
      .then(r => r.json())
      .then(d => { if (d.permissions) setPerms(d.permissions); })
      .catch(() => {});
  }, []);

  const toggle = (k) => {
    setPerms(p => ({ ...p, [k]: !p[k] }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/permissions/role', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(perms),
      });
      const d = await r.json();
      if (d.ok) {
        setDirty(false);
        toast.push(t('perm.saved'), 'success');
      } else {
        toast.push(d.error || t('common.error'), 'error');
      }
    } catch { toast.push(t('common.net_error'), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="card" style={{marginTop: 20}}>
      <div className="card-header">
        <I4U.IconShield size={14} style={{color:'var(--red)'}}/>
        <div className="card-title">{t('perm.title')}</div>
      </div>
      <div className="card-body col" style={{gap: 14}}>
        <div style={{
          padding: '10px 12px', borderRadius: 'var(--radius)',
          background: 'var(--bg-3)', fontSize: 12.5, color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <I4U.IconShield size={13} style={{color:'var(--red)', flexShrink: 0}}/>
          <span>{t('perm.admin_note')}</span>
        </div>

        {perms === null ? (
          <div className="muted" style={{fontSize: 12.5}}>{t('common.loading')}</div>
        ) : (
          <div className="col" style={{gap: 10}}>
            {PERMISSION_DEFS.map(def => {
              const on = !!perms[def.key];
              return (
                <div key={def.key} className="row-between" style={{gap: 12}}>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div style={{fontSize: 13, fontWeight: 500}}>{t(def.label)}</div>
                    <div className="muted" style={{fontSize: 11.5}}>{t(def.hint)}</div>
                  </div>
                  <window.AppShell.Switch
                    on={on}
                    ariaLabel={t(def.label)}
                    style={{flexShrink: 0}}
                    onChange={() => toggle(def.key)}
                  />
                </div>
              );
            })}
          </div>
        )}

        <div className="row" style={{justifyContent:'flex-end', gap: 6}}>
          <button
            className="btn btn-sm btn-primary"
            onClick={save}
            disabled={!dirty || saving || perms === null}
          >
            {saving
              ? <><I4U.IconRefresh size={12} style={{animation:'spin 1s linear infinite'}}/> {t('common.saving')}</>
              : <><I4U.IconCheck size={12}/> {t('common.save')}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

window.AppPagesSettings = window.AppPagesSettings || {};
window.AppPagesSettings.PageUsers = PageUsers;
