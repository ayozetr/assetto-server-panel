// Pages: Config, Users
const { useState: useStateC } = React;
const I4 = window.AppIcons;

function PageConfig({ config, setConfig, isAdmin, onSave }) {
  const [dirty, setDirty] = useStateC(false);
  const set = (k, v) => { setConfig(c => ({...c, [k]: v})); setDirty(true); };

  const save = () => { onSave(); setDirty(false); };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Configuración del servidor</h1>
        <p className="page-sub">Ajustes globales. Algunos requieren reinicio del servidor.</p>
      </div>

      {!isAdmin && (
        <div className="card" style={{marginBottom: 16, padding: '12px 16px', background: 'var(--bg-3)', display:'flex', alignItems:'center', gap: 10}}>
          <I4.IconLock size={14} style={{color: 'var(--text-muted)'}}/>
          <span style={{fontSize: 13, color: 'var(--text-muted)'}}>Solo los administradores pueden modificar estos ajustes.</span>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div className="card-title">Identidad</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="field">
              <label className="field-label">Nombre del servidor</label>
              <input className="input" value={config.name} onChange={e=>set('name', e.target.value)} disabled={!isAdmin}/>
            </div>
            <div className="field">
              <label className="field-label">Descripción</label>
              <textarea className="textarea" rows="3" value={config.description} onChange={e=>set('description', e.target.value)} disabled={!isAdmin}/>
            </div>
            <div className="field">
              <label className="field-label">Mensaje de bienvenida</label>
              <input className="input" value={config.welcome} onChange={e=>set('welcome', e.target.value)} disabled={!isAdmin}/>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Red</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Puerto TCP</label>
                <input className="input mono" type="number" value={config.tcp} onChange={e=>set('tcp', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
              <div className="field">
                <label className="field-label">Puerto UDP</label>
                <input className="input mono" type="number" value={config.udp} onChange={e=>set('udp', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">HTTP</label>
                <input className="input mono" type="number" value={config.http} onChange={e=>set('http', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
              <div className="field">
                <label className="field-label">Tickrate (Hz)</label>
                <input className="input mono" type="number" value={config.tickrate} onChange={e=>set('tickrate', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
            </div>
            <div className="row-between">
              <div>
                <div style={{fontSize: 13, fontWeight: 500}}>Registrar en lobby público</div>
                <div className="muted" style={{fontSize: 11.5}}>Aparecer en el listado oficial de Kunos</div>
              </div>
              <div className={`switch ${config.publicLobby ? 'on' : ''}`} onClick={()=>isAdmin && set('publicLobby', !config.publicLobby)}></div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-title">Acceso</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="field">
              <label className="field-label">Contraseña del servidor</label>
              <input className="input" type="password" value={config.password} onChange={e=>set('password', e.target.value)} placeholder="(sin contraseña)" disabled={!isAdmin}/>
              <span className="field-hint">Vacío = servidor abierto</span>
            </div>
            <div className="field">
              <label className="field-label">Contraseña admin</label>
              <input className="input" type="password" value={config.adminPass} onChange={e=>set('adminPass', e.target.value)} disabled={!isAdmin}/>
            </div>
            <div className="row-between">
              <div>
                <div style={{fontSize: 13, fontWeight: 500}}>Whitelist activa</div>
                <div className="muted" style={{fontSize: 11.5}}>Solo Steam IDs autorizados pueden conectar</div>
              </div>
              <div className={`switch ${config.whitelist ? 'on' : ''}`} onClick={()=>isAdmin && set('whitelist', !config.whitelist)}></div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <I4.IconFolder size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Rutas del servidor (Linux)</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="field">
              <label className="field-label">Raíz del servidor</label>
              <input className="input mono" value={config.path} onChange={e=>set('path', e.target.value)} disabled={!isAdmin} placeholder="/srv/assetto"/>
              <span className="field-hint">Carpeta padre que contiene cfg/, content/ y presets/</span>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Binario acServer</label>
                <input className="input mono" value={config.binPath} onChange={e=>set('binPath', e.target.value)} disabled={!isAdmin} placeholder="/srv/assetto/ac_server/acServer"/>
              </div>
              <div className="field">
                <label className="field-label">Contenido (cars/tracks)</label>
                <input className="input mono" value={config.contentPath} onChange={e=>set('contentPath', e.target.value)} disabled={!isAdmin} placeholder="/srv/assetto/content"/>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Configuración (cfg)</label>
                <input className="input mono" value={config.cfgPath} onChange={e=>set('cfgPath', e.target.value)} disabled={!isAdmin}/>
              </div>
              <div className="field">
                <label className="field-label">Resultados</label>
                <input className="input mono" value={config.resultsPath} onChange={e=>set('resultsPath', e.target.value)} disabled={!isAdmin}/>
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Logs</label>
                <input className="input mono" value={config.logsPath} onChange={e=>set('logsPath', e.target.value)} disabled={!isAdmin}/>
              </div>
              <div className="field">
                <label className="field-label">BBDD tiempos</label>
                <input className="input mono" value={config.dbPath} onChange={e=>set('dbPath', e.target.value)} disabled={!isAdmin}/>
              </div>
            </div>
            <div className="field">
              <label className="field-label">Usuario systemd</label>
              <input className="input mono" value={config.sysUser} onChange={e=>set('sysUser', e.target.value)} disabled={!isAdmin}/>
            </div>
            <div className="grid-2">
              <div className="row-between">
                <span style={{fontSize: 13}}>Auto-arranque</span>
                <div className={`switch ${config.autoStart ? 'on' : ''}`} onClick={()=>isAdmin && set('autoStart', !config.autoStart)}></div>
              </div>
              <div className="row-between">
                <span style={{fontSize: 13}}>Reiniciar al fallar</span>
                <div className={`switch ${config.autoRestart ? 'on' : ''}`} onClick={()=>isAdmin && set('autoRestart', !config.autoRestart)}></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {isAdmin && (
        <div className="row" style={{marginTop: 20, justifyContent: 'flex-end', gap: 8, position:'sticky', bottom: 16, background:'var(--bg-2)', padding:'10px 0'}}>
          {dirty && <span className="badge badge-amber">Cambios sin guardar</span>}
          <button className="btn" onClick={()=>setDirty(false)}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty}>
            <I4.IconCheck size={13}/> Guardar cambios
          </button>
        </div>
      )}
    </>
  );
}

function PageUsers({ users, setUsers, isAdmin }) {
  const [editing, setEditing] = useStateC(null); // null | {id?, ...}
  const [confirmDel, setConfirmDel] = useStateC(null);

  if (!isAdmin) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Usuarios</h1>
        </div>
        <div className="card">
          <div className="empty">
            <I4.IconLock size={20} style={{display:'block', margin:'0 auto 10px'}}/>
            Solo los administradores pueden ver esta sección.
          </div>
        </div>
      </>
    );
  }

  const save = (u) => {
    if (u.id) {
      setUsers(us => us.map(x => x.id === u.id ? { ...x, ...u } : x));
    } else {
      setUsers(us => [...us, { ...u, id: Math.max(...us.map(x => x.id), 0) + 1, created: new Date().toISOString().slice(0,10), active: true }]);
    }
    setEditing(null);
  };

  return (
    <>
      <div className="page-header row-between">
        <div>
          <h1 className="page-title">Usuarios</h1>
          <p className="page-sub">{users.length} cuentas con acceso al panel.</p>
        </div>
        <button className="btn btn-primary" onClick={()=>setEditing({ name: '', email: '', role: 'user', password: '' })}>
          <I4.IconPlus size={13}/> Nuevo usuario
        </button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Email</th>
              <th>Rol</th>
              <th>Creado</th>
              <th>Estado</th>
              <th style={{width: 120}}></th>
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
                <td className="muted">{u.email}</td>
                <td>
                  {u.role === 'admin'
                    ? <span className="badge badge-red"><I4.IconShield size={10}/> Admin</span>
                    : <span className="badge">Usuario</span>}
                </td>
                <td className="muted mono" style={{fontSize: 12}}>{u.created}</td>
                <td>
                  {u.active
                    ? <span className="badge badge-green">Activo</span>
                    : <span className="badge">Inactivo</span>}
                </td>
                <td>
                  <div className="row" style={{gap: 4}}>
                    <button className="icon-btn" onClick={()=>setEditing(u)} title="Editar"><I4.IconEdit size={14}/></button>
                    <button className="icon-btn" onClick={()=>setConfirmDel(u)} title="Eliminar"><I4.IconTrash size={14}/></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <UserModal user={editing} onClose={()=>setEditing(null)} onSave={save}/>}
      {confirmDel && (
        <ConfirmModal
          title={`Eliminar usuario "${confirmDel.name}"`}
          message="Esta acción no se puede deshacer. El usuario perderá acceso inmediatamente."
          onCancel={()=>setConfirmDel(null)}
          onConfirm={()=>{ setUsers(us => us.filter(x => x.id !== confirmDel.id)); setConfirmDel(null); }}
        />
      )}
    </>
  );
}

function UserModal({ user, onClose, onSave }) {
  const [form, setForm] = useStateC({ ...user, password: '' });
  const set = (k, v) => setForm(f => ({...f, [k]: v}));
  const valid = form.name && form.email;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header">
          <I4.IconUser size={15}/>
          <div className="modal-title">{user.id ? 'Editar usuario' : 'Nuevo usuario'}</div>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">Nombre de usuario</label>
            <input className="input" value={form.name} onChange={e=>set('name', e.target.value)}/>
          </div>
          <div className="field">
            <label className="field-label">Email</label>
            <input className="input" type="email" value={form.email} onChange={e=>set('email', e.target.value)}/>
          </div>
          <div className="field">
            <label className="field-label">Rol</label>
            <div className="segmented" style={{alignSelf:'flex-start'}}>
              <button className={form.role === 'user' ? 'active' : ''} onClick={()=>set('role', 'user')}>Usuario</button>
              <button className={form.role === 'admin' ? 'active' : ''} onClick={()=>set('role', 'admin')}>Admin</button>
            </div>
          </div>
          <div className="field">
            <label className="field-label">{user.id ? 'Nueva contraseña (opcional)' : 'Contraseña'}</label>
            <input className="input" type="password" value={form.password} onChange={e=>set('password', e.target.value)} placeholder={user.id ? 'Dejar vacío para no cambiar' : '••••••••'}/>
          </div>
          {user.id && (
            <div className="row-between" style={{paddingTop: 4}}>
              <span style={{fontSize: 13}}>Cuenta activa</span>
              <div className={`switch ${form.active ? 'on' : ''}`} onClick={()=>set('active', !form.active)}></div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={!valid} onClick={()=>onSave(form)}>
            <I4.IconCheck size={13}/> Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, onCancel, onConfirm }) {
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
          <button className="btn" onClick={onCancel}>Cancelar</button>
          <button className="btn btn-primary" onClick={onConfirm} style={{background: 'var(--red)', borderColor: 'var(--red)'}}>
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}

window.AppPagesC = { PageConfig, PageUsers, ConfirmModal };
