// Pages: Config, Users, Profile
const { useState: useStateC, useEffect: useEffectC } = React;
const I4 = window.AppIcons;

function PageConfig({ config, setConfig, isAdmin, onSave }) {
  const toast  = window.AppShell.useToast();
  const [dirty,  setDirty]  = useStateC(false);
  const [saving, setSaving] = useStateC(false);
  const set = (k, v) => { setConfig(c => ({...c, [k]: v})); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try { await onSave(); setDirty(false); }
    catch { toast.push('Error al guardar', 'error'); }
    finally { setSaving(false); }
  };

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
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Máx. clientes</label>
                <input className="input mono" type="number" min="1" max="200" value={config.maxClients ?? 16} onChange={e=>set('maxClients', Number(e.target.value))} disabled={!isAdmin}/>
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
            <I4.IconFlag size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Reglas de carrera</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="grid-2">
              <div className="field">
                <label className="field-label">Combustible (%)</label>
                <input className="input mono" type="number" min="0" max="200" value={config.fuelRate ?? 100} onChange={e=>set('fuelRate', Number(e.target.value))} disabled={!isAdmin}/>
                <span className="field-hint">0 = ilimitado</span>
              </div>
              <div className="field">
                <label className="field-label">Daños (%)</label>
                <input className="input mono" type="number" min="0" max="200" value={config.damage ?? 100} onChange={e=>set('damage', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
              <div className="field">
                <label className="field-label">Desgaste neumáticos (%)</label>
                <input className="input mono" type="number" min="0" max="200" value={config.tyreWear ?? 100} onChange={e=>set('tyreWear', Number(e.target.value))} disabled={!isAdmin}/>
              </div>
            </div>
            <div className="grid-2">
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>ABS permitido</div>
                  <div className="muted" style={{fontSize: 11.5}}>0=prohibido, 1=solo fábrica, 2=libre</div>
                </div>
                <select className="select" style={{width: 80}} value={config.abs ?? 0} onChange={e=>isAdmin && set('abs', Number(e.target.value))} disabled={!isAdmin}>
                  <option value={0}>No</option>
                  <option value={1}>Fábrica</option>
                  <option value={2}>Libre</option>
                </select>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>TC permitido</div>
                  <div className="muted" style={{fontSize: 11.5}}>Control de tracción</div>
                </div>
                <select className="select" style={{width: 80}} value={config.tc ?? 0} onChange={e=>isAdmin && set('tc', Number(e.target.value))} disabled={!isAdmin}>
                  <option value={0}>No</option>
                  <option value={1}>Fábrica</option>
                  <option value={2}>Libre</option>
                </select>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>Embrague automático</div>
                </div>
                <div className={`switch ${config.autoclutch ? 'on' : ''}`} onClick={()=>isAdmin && set('autoclutch', !config.autoclutch)}></div>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>Control de estabilidad</div>
                  <div className="muted" style={{fontSize: 11.5}}>Ayuda a la estabilidad del coche</div>
                </div>
                <div className={`switch ${config.stability ? 'on' : ''}`} onClick={()=>isAdmin && set('stability', !config.stability)}></div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <I4.IconSettings size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Comportamiento</div>
          </div>
          <div className="card-body col" style={{gap: 14}}>
            <div className="grid-2">
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>Auto-arranque</div>
                  <div className="muted" style={{fontSize: 11.5}}>Iniciar con el sistema</div>
                </div>
                <div className={`switch ${config.autoStart ? 'on' : ''}`} onClick={()=>isAdmin && set('autoStart', !config.autoStart)}></div>
              </div>
              <div className="row-between">
                <div>
                  <div style={{fontSize: 13, fontWeight: 500}}>Reiniciar al fallar</div>
                  <div className="muted" style={{fontSize: 11.5}}>Recuperación automática</div>
                </div>
                <div className={`switch ${config.autoRestart ? 'on' : ''}`} onClick={()=>isAdmin && set('autoRestart', !config.autoRestart)}></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {isAdmin && (
        <div className="row" style={{marginTop: 20, justifyContent: 'flex-end', gap: 8, position:'sticky', bottom: 16, background:'var(--bg-2)', padding:'10px 0'}}>
          {dirty && !saving && <span className="badge badge-amber">Cambios sin guardar</span>}
          <button className="btn" onClick={()=>setDirty(false)} disabled={saving}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving
              ? <><I4.IconRefresh size={13} style={{animation:'spin 1s linear infinite'}}/> Guardando…</>
              : <><I4.IconCheck size={13}/> Guardar cambios</>}
          </button>
        </div>
      )}
    </>
  );
}

function PageUsers({ users, setUsers, isAdmin }) {
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
        <div className="page-header"><h1 className="page-title">Usuarios</h1></div>
        <div className="card">
          <div className="empty">
            <I4.IconLock size={20} style={{display:'block', margin:'0 auto 10px'}}/>
            Solo los administradores pueden ver esta sección.
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
          toast.push('La contraseña debe tener al menos 8 caracteres', 'error'); return;
        }
        r = await fetch('/api/panel/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: form.name, password: form.password, role: form.role }),
        });
      }
      const d = await r.json();
      if (d.error) { toast.push(d.error, 'error'); return; }
      toast.push(form.id ? 'Usuario actualizado' : 'Usuario creado', 'success');
      setEditing(null);
      loadUsers();
    } catch { toast.push('Error de conexión', 'error'); }
  };

  const deleteUser = async (u) => {
    try {
      await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' });
      toast.push(`Usuario "${u.name}" eliminado`, 'success');
      setConfirmDel(null);
      loadUsers();
    } catch { toast.push('Error al eliminar', 'error'); }
  };

  return (
    <>
      <div className="page-header row-between">
        <div>
          <h1 className="page-title">Usuarios</h1>
          <p className="page-sub">{users.length} cuentas con acceso al panel.</p>
        </div>
        <button className="btn btn-primary" onClick={()=>setEditing({ name: '', role: 'user', password: '' })}>
          <I4.IconPlus size={13}/> Nuevo usuario
        </button>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Rol</th>
              <th>Creado</th>
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
                    : <span className="badge">Usuario</span>}
                </td>
                <td className="muted mono" style={{fontSize: 12}}>{u.created}</td>
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

      {editing && <UserModal user={editing} onClose={()=>setEditing(null)} onSave={saveUser}/>}
      {confirmDel && (
        <ConfirmModal
          title={`Eliminar usuario "${confirmDel.name}"`}
          message="Esta acción no se puede deshacer. El usuario perderá acceso inmediatamente."
          onCancel={()=>setConfirmDel(null)}
          onConfirm={()=>deleteUser(confirmDel)}
        />
      )}
    </>
  );
}

function UserModal({ user, onClose, onSave }) {
  const [form,    setForm]    = useStateC({ ...user, password: '' });
  const [pwError, setPwError] = useStateC('');
  const set = (k, v) => setForm(f => ({...f, [k]: v}));
  const valid = form.name.trim().length > 0;
  const submit = () => {
    if (!user.id && form.password.length > 0 && form.password.length < 8) {
      setPwError('Mínimo 8 caracteres'); return;
    }
    setPwError('');
    onSave(form);
  };
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
            <input className="input" value={form.name} onChange={e=>set('name', e.target.value)} disabled={!!user.id}/>
            {user.id && <span className="field-hint">El nombre de usuario no se puede cambiar</span>}
          </div>
          <div className="field">
            <label className="field-label">Rol</label>
            <div className="segmented" style={{alignSelf:'flex-start'}}>
              <button className={form.role === 'user' ? 'active' : ''} onClick={()=>set('role', 'user')}>Usuario</button>
              <button className={form.role === 'admin' ? 'active' : ''} onClick={()=>set('role', 'admin')}>Admin</button>
            </div>
          </div>
          <div className="field">
            <label className="field-label">{user.id ? 'Nueva contraseña (opcional)' : 'Contraseña *'}</label>
            <input className="input" type="password" value={form.password} onChange={e=>set('password', e.target.value)}
              placeholder={user.id ? 'Dejar vacío para no cambiar' : '••••••••  (mín. 8 caracteres)'}/>
            {pwError && <span className="field-hint" style={{color:'var(--red)'}}>{pwError}</span>}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={!valid} onClick={submit}>
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

// ── Profile / Change password ─────────────────────────────────────────────────
function PageProfile({ user }) {
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
      () => toast.push('Contraseña copiada', 'success'),
      () => toast.push('No se pudo copiar', 'warn')
    );
  };

  const useGeneratedPassword = () => {
    if (!generated) return;
    setNewPw(generated);
    setConfirmPw(generated);
    toast.push('Contraseña insertada en los campos', 'info');
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setFormError('');
    if (!currentPw || !newPw || !confirmPw) { setFormError('Todos los campos son obligatorios'); return; }
    if (newPw !== confirmPw) { setFormError('Las contraseñas nuevas no coinciden'); return; }
    if (newPw.length < 8) { setFormError('La contraseña debe tener al menos 8 caracteres'); return; }
    if (newPw === currentPw) { setFormError('La nueva contraseña debe ser diferente a la actual'); return; }
    setSaving(true);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.name, currentPassword: currentPw, newPassword: newPw }),
      });
      const d = await r.json();
      if (d.ok) {
        toast.push('Contraseña actualizada correctamente', 'success');
        setCurrentPw(''); setNewPw(''); setConfirmPw('');
      } else {
        setFormError(d.error || 'Error al cambiar la contraseña');
      }
    } catch {
      setFormError('Error de conexión');
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
        <h1 className="page-title">Mi cuenta</h1>
        <p className="page-sub">Gestiona tu contraseña de acceso al panel.</p>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <I4.IconKey size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Cambiar contraseña</div>
          </div>
          <form className="card-body col" style={{gap:14}} onSubmit={handleSubmit}>
            <div className="field">
              <label className="field-label">Contraseña actual</label>
              <div style={{position:'relative'}}>
                <input className="input" type={showCurrent ? 'text' : 'password'}
                  value={currentPw} onChange={e=>setCurrentPw(e.target.value)}
                  placeholder="••••••••" style={{paddingRight:36}}/>
                {eyeBtn(showCurrent, () => setShowCurrent(v=>!v))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">Contraseña nueva</label>
              <div style={{position:'relative'}}>
                <input className="input" type={showNew ? 'text' : 'password'}
                  value={newPw} onChange={e=>setNewPw(e.target.value)}
                  placeholder="••••••••" style={{paddingRight:36}}/>
                {eyeBtn(showNew, () => setShowNew(v=>!v))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">Confirmar contraseña nueva</label>
              <input className="input" type="password"
                value={confirmPw} onChange={e=>setConfirmPw(e.target.value)}
                placeholder="••••••••"/>
            </div>
            {formError && <div style={{fontSize:12,color:'var(--red)'}}>{formError}</div>}
            <button type="submit" className="btn btn-primary" disabled={saving} style={{alignSelf:'flex-start'}}>
              <I4.IconCheck size={13}/> {saving ? 'Guardando…' : 'Cambiar contraseña'}
            </button>
          </form>
        </div>

        <div className="card">
          <div className="card-header">
            <I4.IconRefresh size={14} style={{color:'var(--red)'}}/>
            <div className="card-title">Generador de contraseña segura</div>
          </div>
          <div className="card-body col" style={{gap:14}}>
            <div className="field">
              <label className="field-label">Longitud: <strong>{genLength}</strong> caracteres</label>
              <input type="range" min="8" max="24" value={genLength}
                onChange={e=>setGenLength(Number(e.target.value))}
                style={{width:'100%',accentColor:'var(--red)',cursor:'pointer'}}/>
              <div className="row-between" style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>
                <span>8</span><span>16</span><span>24</span>
              </div>
            </div>

            <div className="row-between">
              <div>
                <div style={{fontSize:13,fontWeight:500}}>Caracteres especiales</div>
                <div className="muted" style={{fontSize:11.5}}>!@#$%^&amp;*()_+-=[]{}|</div>
              </div>
              <div className={`switch ${genSpecial ? 'on' : ''}`} onClick={()=>setGenSpecial(v=>!v)}></div>
            </div>

            <div className="field">
              <label className="field-label">Contraseña generada</label>
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
                <button type="button" className="icon-btn" onClick={copyPassword} title="Copiar al portapapeles">
                  <I4.IconCopy size={14}/>
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={useGeneratedPassword}>
                  Usar
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
