# Authentication & Users

## How login works

The panel uses a session-based authentication system backed by SQLite.

1. The user submits their username and password.
2. The server looks up the user in the `panel_users` table and verifies the password using **scrypt** with a constant-time compare. Cost parameters are pinned in the `SCRYPT_PARAMS` constant (`N=16384, r=8, p=1`, 64-byte output) and passed explicitly to both hash and verify, so the comparison never silently relies on Node's defaults. Legacy hashes (PBKDF2-SHA512 from older deployments) are still accepted and lazily upgraded to scrypt on the next successful login.
3. If valid, a session token is generated, stored in the `sessions` table with a 7-day expiry, and set as an `HttpOnly` cookie named `sid` (`SameSite=Strict; Path=/`). The `Secure` flag is appended automatically when the request arrived over HTTPS (direct or via `X-Forwarded-Proto: https`).
4. The browser sends the cookie automatically with every API request.
5. On logout, the token is deleted from the database immediately and the cookie is cleared.

**Rate limiting:** 5 failed login or change-password attempts per IP address lock both endpoints for 15 minutes. Lockout state is **persisted to SQLite** (`login_attempts` table), so a brute-forcer cannot reset the counter by triggering a server restart. A sweeper drops expired rows every 30 min.

**CSRF protection:** state-changing requests (POST/PUT/DELETE/PATCH) must come from the same `Origin` (or `Referer`) as the request `Host`; mismatches return `403`. Combined with `SameSite=Strict` cookies this blocks cross-site requests at two layers.

---

## First-login password change

The default admin account is seeded with `must_change_password = 1`. Until the flag is cleared, the user is locked into the change-password flow.

**Server-side enforcement** — the gate runs *after* the session check in the API router:

- Public auth endpoints stay reachable: `/api/auth/me`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/change-password`.
- **Every other authenticated endpoint** (`/api/config`, `/api/server/start`, `/api/panel/users`, `/api/mods/upload`, etc.) returns `403 { error: "Password change required", mustChangePassword: true }` while the flag is set, *regardless of role*.
- This is a server-side block. Even a custom HTTP client bypassing the UI cannot reach admin endpoints with the seeded credentials.

**Client-side flow** — `src/app.jsx` watches `mustChangePassword`:

- On login (or `/api/auth/me` response), if `mustChangePassword` is true, the panel renders a blocking **forced-change modal** (`ForcePasswordChange` component in `src/shell.jsx`) instead of the main UI.
- The modal contains the change-password form and a *Log out* button — there is no other reachable control until the password is changed.
- After a successful password change the flag is cleared in the DB and `setUser` flips the local flag to `false`, so the modal unmounts and `AppInner` renders normally.

**Recovery** — if you lock yourself out (e.g. forgot the new password before clearing the flag), open the SQLite DB and run:

```sql
UPDATE panel_users SET must_change_password = 0 WHERE username = 'Admin';
```

Then log in normally and use the **Reset password** flow.

---

## Roles

| Role | Access |
|------|--------|
| `admin` | Always passes every permission check. Exclusively allowed to manage panel users (create / delete / change role / reset password), edit the AC server `PASSWORD` and `ADMIN_PASSWORD` fields, wipe mod history, and consult the role-permissions card itself. |
| `user` | Read access + own profile by default. Anything beyond that is configured per-permission by an admin (see [Granular permissions](#granular-permissions)). The defaults preserve the open grants from before the granular system existed: `serverControl`, `sessionEdit` and `modUpload` are on; the rest are off. |

---

## Granular permissions

The `user` role is gated by a set of nine independent boolean toggles edited
from the **Usuarios** page (admin only). They are stored as a single JSON value
under the key `role_permissions_user` in `panel_settings`, and surface on
`/api/auth/me` so the frontend can hide buttons / pages the user cannot use.

| Permission | When `true`, the `user` role can… |
|------------|------------------------------------|
| `serverControl`    | Start / stop / restart / reload the AC server from the topbar. |
| `sessionEdit`      | Edit the session (track, layout, cars, skins, weather, time, penalties) and apply it. |
| `serverConfig`     | Edit `server_cfg.ini` — name, ports, race rules, etc. AC `PASSWORD` and `ADMIN_PASSWORD` stay admin-only inside the same endpoint. |
| `whitelistManage`  | Add / remove Steam IDs from the whitelist (per-player button on Players + the editor on Configuración). |
| `playerModeration` | Kick / ban connected drivers, edit panel nicknames. |
| `modUpload`        | Upload mods. The Mods page still loads in read-only mode for users without this permission, so they can see the history. |
| `discordWebhook`   | View / edit the Discord webhook URL and trigger the test post. |
| `auditView`        | See the **Audit** page. |
| `dbBackup`         | Download a manual `assetto.db` backup. |

Every action is recorded in the audit log with the actor's username so a per-user
trail survives even when a permission set is broad.

Server-side checks live in a single helper:

```js
function checkPermission(req, perm) {
  const sess = getSession(req);
  if (!sess) return false;
  if (userMustChangePassword(sess.username)) return false;
  if (sess.role === 'admin') return true;
  return !!getUserRolePermissions()[perm];
}
```

Admin always passes. Users with a forced-change-password flag never do (they
are bounced into the change-password modal regardless of role or permission).

Editing a permission takes effect immediately for affected users: the panel
re-reads `/api/auth/me` on mount, and any subsequent request from the affected
user hits the updated server-side check. There is also a hard server-side
recheck on `body.restart=true` inside `apiConfigUpdate` so a user with only
`serverConfig` cannot bypass `serverControl` by saving + restart in one call.

> **Reserved actions that no permission can grant a non-admin.** Managing
> panel users (create / delete / change role / reset password), editing the
> AC server `PASSWORD` and `ADMIN_PASSWORD` fields, wiping the mod-history
> table, and reading or writing the role-permission set itself are all
> admin-only by design — exposing them as toggles would let a `user` escalate
> to admin or silently grant themselves more permissions.

---

## Default credentials

| Username | Password | Role |
|----------|----------|------|
| `Admin` | `Admin1234!` | admin |

> The panel forces a password change on first login — you cannot use any other page until the default password is replaced.

---

## Managing users

Admins can manage panel users from the **Users** page:

- **Create** a new user with a username, password and role — username must be 1–64 characters: letters, numbers, `_` and `-` only
- **Change role** between `admin` and `user` (the panel refuses to demote the last remaining admin — this would leave the panel with no admin and no recoverable login)
- **Reset password** for any user
- **Delete** a user (cannot delete yourself; the panel also refuses to delete the last remaining admin)

> **Active sessions are revoked** automatically when an admin resets a user's password or deletes a user. The affected user's browser will get `401` on its next API call and be logged out.

Users can change their own password from the **My account** page (requires entering the current password).

### Password policy

The server enforces (and the client mirrors) the same minimum strength on every password change:

- **≥ 12 characters**, **or**
- **≥ 8 characters and a mix of three classes** (lowercase / UPPERCASE / digit / symbol).
- Maximum length: 128.
- A short blacklist (`password`, `qwerty12`, `admin1234`, etc.) is rejected outright.

Generated passwords always satisfy the policy.

### Password generator

The My account page includes a built-in secure password generator:
- Length slider (8–24 characters)
- Toggle for special characters
- Live preview field with copy and "use" buttons

Internally it uses `crypto.getRandomValues()` with rejection sampling to avoid modulo bias — `Math.random()` is **not** used.

---

## Sessions table

Active sessions are stored in SQLite:

```sql
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  role       TEXT NOT NULL,
  expires_at INTEGER NOT NULL   -- Unix timestamp in milliseconds
);
```

Sessions expire automatically after 7 days. Expired tokens are cleaned up on each new login.
