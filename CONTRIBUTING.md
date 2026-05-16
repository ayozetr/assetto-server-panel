# Contributing to Assetto Server Panel

Thanks for taking the time to look at how to help. This page covers the three ways you can contribute and how each of them maps to the project's [LICENSE](LICENSE) terms.

> **Quick orientation**: the panel is intentionally **source-available, not open source**. Use is free for anyone (private, public, commercial), but redistribution and public forking are not permitted. That sounds restrictive but it does not block contributions — it just means the contribution path is slightly different from a typical permissive-licensed project. Read on.

---

## 1. Reporting bugs

Go to the [issue tracker](https://github.com/ayozetr/assetto-server-panel/issues/new/choose) and pick the **Bug report** template. It asks for:

- What happened vs what you expected.
- Steps to reproduce (the more concrete, the faster I can fix it).
- Environment: panel version, install method (bare metal / Docker), OS + kernel, Node version, whether you're behind a reverse proxy.
- Relevant logs from `journalctl -u assetto-dashboard` or `docker compose logs`. **Redact any session cookies, `ADMIN_TOKEN`, real Steam GUIDs, and passwords** before pasting.

A good bug report saves a back-and-forth — please don't skip the environment section even if the bug seems obvious.

## 2. Reporting security vulnerabilities

**Do not open a public issue for security issues.** Use the private channel:

- [Open a Security Advisory](https://github.com/ayozetr/assetto-server-panel/security/advisories/new) — only the maintainer and you can see it.
- Alternatively, email the address listed in `package.json` if the Advisories form doesn't work for you.

Public CVEs for an unpatched panel give attackers a roadmap. Please don't.

What counts as a security issue:

- Authentication / authorization bypass.
- CSRF, XSS, SSRF, path traversal, SQL injection, command injection.
- Insecure session handling, leak of `ADMIN_TOKEN` or `ADMIN_PASSWORD`.
- Mod-upload paths that could escape the content dir.
- Anything that lets a `viewer` role do something a `viewer` shouldn't.

What does **not** count (open a normal issue instead):

- Missing security headers on a non-exploitable surface.
- Best-practice suggestions without a working PoC.
- "Default password is weak" — covered in the docs, operator's job to change.

## 3. Suggesting features / improvements

Open an issue with the **Feature request** template. Lead with the **problem** ("league hosts cannot schedule practice-only nights"), not the **solution** ("add a cron field to sessions") — leading with the problem leaves room for me to find a better fix than the one you had in mind.

Before writing, check:

- [`ROADMAP.md`](ROADMAP.md) — your idea might already be in the backlog.
- [`CHANGELOG.md`](CHANGELOG.md) — it might already be shipped in a recent version.

## 4. Contributing code

Because the LICENSE prohibits public forks, the contribution flow is slightly different from a typical permissive-licensed project on GitHub:

1. **Open an issue first** describing the change. For anything beyond a one-line typo fix, agreement on scope before code is written saves both of us time.
2. **Wait for confirmation.** I'll respond on the issue with one of:
    - "Yes, please go ahead" — proceed to step 3.
    - "I'd rather do this differently" — counter-proposal, we converge on a plan.
    - "No, this doesn't fit" — sometimes happens; I'll explain why.
3. **I'll add you as a temporary collaborator** with push access to a feature branch (not `main`).
4. **You push to that branch** and open a PR against `main` from the same repository. No fork required — the LICENSE-friendly flow.
5. **Review + merge.** I'll squash-merge with a commit message that credits you in the body.
6. **I'll remove your collaborator access** after the PR lands. This is not personal — it's hygiene; collaborator access is scoped to active work.

For very small fixes (typos in docs, fixing a broken link, correcting a clearly-wrong comment) you can skip step 1-3 and just describe the fix in an issue — I may apply it directly and credit you, faster for everyone.

### Code style and commits

- **Commits in English**, descriptive, no `Co-Authored-By` trailers, no AI attribution lines. Imperative voice ("fix: …", "feat: …", "docs: …") matching the existing style — `git log` is the canonical reference.
- **One change per commit.** A typo fix and a feature in the same commit is harder to review and harder to revert.
- **Don't add comments that explain *what* the code does** — well-named identifiers already do that. Only add a comment when the *why* is non-obvious: a hidden constraint, a subtle invariant, a workaround.
- **No new top-level dependencies** without discussion in the issue. Existing ones (esbuild, better-sqlite3, dotenv, the unzip libraries) are pinned and audited; adding a new one means audit + lockfile churn.
- **Pass the smoke tests** before pushing: `npm test`. Failing tests block merge.
- **No new files in the project root** without a reason. Prefer editing existing files.

### Running locally

Quick path:

```bash
npm install
npm run setup        # interactive .env wizard (skips if .env already exists)
npm run build        # esbuild transpile of all JSX → dist/
npm start            # boots on http://localhost:3000
```

Smoke tests + supply-chain audit:

```bash
npm test
npm run audit:deps
```

Full setup, environment variables, paths, reverse proxy: [`docs/installation.md`](docs/installation.md) and [`docs/deployment.md`](docs/deployment.md).

## 5. Things you should NOT do

To be explicit, because the LICENSE is unusual:

- ❌ **Do not publish a public fork** of this repository under your own name. The LICENSE prohibits redistribution of the source. Transient forks for the PR flow are unnecessary anyway because step 3 above gives you direct push access.
- ❌ **Do not upload this code to package registries** (npm, GitHub Releases of your own fork, Docker Hub under your namespace, etc.).
- ❌ **Do not remove or alter the attribution marks** ("Developed by ayozetr" and any other references to the project / maintainer in `LICENSE`, `README`, the panel UI, or the source comments). The LICENSE makes these irremovable.
- ❌ **Do not bundle the panel into another product** for redistribution.

Local modifications for your own use are fine — that's what the LICENSE explicitly permits. The line is "for your own deployment" vs "redistributed to others".

## 6. Recognition

Code contributors are credited in the commit body of the squash merge that lands their change. There is no separate `CONTRIBUTORS.md` because the commit history is the source of truth — searchable, durable, and impossible to lose.

If you'd like to support the project in a different way, the [Sponsor button](https://ko-fi.com/ayozetr) at the top of the repo is the place — it goes to my Ko-fi and covers test-server bills and time. Optional, never expected.

## 7. Questions

If you're not sure whether to open an issue or how the LICENSE applies to what you want to do, open an issue anyway — *"I'm not sure if X is allowed under the LICENSE"* is a perfectly valid question and quicker to answer than guessing.

Thanks for reading this far. 🏁
