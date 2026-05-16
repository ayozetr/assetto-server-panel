---
name: Bug report
about: Something is broken or behaves differently from what the docs say.
title: "[bug] <short summary>"
labels: bug
assignees: ayozetr

---

## What happened

<!-- One or two sentences. What did you do, what did you see? -->

## What you expected to happen

<!-- The behaviour the docs / README implied. -->

## Steps to reproduce

1.
2.
3.

## Environment

- Panel version: <!-- e.g. 1.4.1 — visible in the top-right of the UI or in `package.json` -->
- Install method: <!-- bare metal / Docker / docker-compose -->
- Host OS + kernel: <!-- `uname -srm` + `cat /etc/os-release | head -3` -->
- Node.js: <!-- `node --version` (skip if Docker) -->
- Behind a reverse proxy?: <!-- Cloudflare Tunnel / nginx / Caddy / none — and is `TRUST_PROXY` set? -->
- Browser + version: <!-- only if the issue is visual / frontend -->

## Logs

<!--
Paste any relevant lines from:
  - `journalctl -u assetto-dashboard --since "10 minutes ago"`  (systemd)
  - `docker compose logs --tail=200 assetto-panel`              (Docker)
  - The browser DevTools console for UI bugs
Redact session cookies, ADMIN_TOKEN values, real Steam GUIDs, and any password.
-->

```
<paste-here>
```

## Additional context

<!-- Screenshots, network captures, anything else you think helps. Optional. -->
