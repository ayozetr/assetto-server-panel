# Authentication & Users

## How login works

The panel uses a session-based authentication system backed by SQLite.

1. The user submits their username and password.
2. The server looks up the user in the `panel_users` table and verifies the password using PBKDF2-SHA-512 (100,000 iterations).
3. If valid, a session token is generated, stored in the `sessions` table with a 7-day expiry, and returned to the browser.
4. The browser stores the token in `localStorage` and sends it as a `Bearer` header on every API request.
5. On logout, the token is deleted from the database immediately.

**Rate limiting:** 5 failed login attempts per IP address locks the endpoint for 15 minutes.

---

## Roles

| Role | Access |
|------|--------|
| `admin` | Full access — server control, configuration, user management, mod upload |
| `user` | Read access + mod upload — cannot change server config or manage users |

---

## Default credentials

| Username | Password | Role |
|----------|----------|------|
| `Admin` | `Admin1234!` | admin |

> Change this password immediately after first login.

---

## Managing users

Admins can manage panel users from the **Users** page:

- **Create** a new user with a username, password and role
- **Change role** between `admin` and `user`
- **Reset password** for any user
- **Delete** a user (cannot delete yourself)

Users can change their own password from the **My account** page (requires entering the current password).

### Password generator

The My account page includes a built-in secure password generator:
- Length slider (8–24 characters)
- Toggle for special characters
- Live preview field with copy and "use" buttons

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
