# dsh-egress-router

> **Route only the endpoints that need a proxy. Everything else stays direct.**
> A DSH plugin that opens one loopback port per outbound target and forwards it.

[![ci](https://github.com/funny0A0/dsh-egress-router/actions/workflows/ci.yml/badge.svg)](https://github.com/funny0A0/dsh-egress-router/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A520-informational)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-informational)
![license](https://img.shields.io/badge/license-MIT-informational)

Chinese README (more detailed): [README.md](README.md)

---

## Why

DSH has **one transport answer per process**: `@deepseek-ai/dsh-http-proxy` reads
`HTTPS_PROXY` once at startup and every outbound HTTPS request uses it. There is no
per-provider switch.

So one dead proxy takes down everything that is not in `NO_PROXY`: the account panel
(`platform.deepseek.com`), the plugin catalogue, and `pnpm add`. The chat itself keeps
working only because `api.deepseek.com` is exempt.

| Approach | Blast radius | Granularity |
| --- | --- | --- |
| Global `HTTPS_PROXY` | proxy dies -> account, catalogue and installs die | process |
| Everything direct | endpoints that need a proxy stay unreachable | none |
| **This plugin** | one dead relay affects exactly one target | **per target** |

## What it does

- **Per-target routing** - one `127.0.0.1` port per target, direct or through a named
  upstream proxy, with a custom port.
- **Discovery and probing** - scans `cordis.patch.yml`, `.env` and installed bundles;
  probes direct vs. proxied and reports reachability and latency.
- **Surgical rewrite with rollback** - edits only the provider `baseURL` (comments and
  anchors preserved), backs up first, re-parses after writing, restores on failure.
- **Verify after apply** - listens, sends a real request, rolls back if the target is not
  reachable; no more "looks applied, does not work".
- **Metrics** - requests, bytes in/out, failures, status codes, TTFB p50/p95 per route.
- **Bot egress** - for plugins that hard-code their endpoint (Telegram): a declarative
  patch plus `DSH_TELEGRAM_PROXY`, injected into the host process. It must **not** live in
  `$DSH_HOME/.env`: the launcher refuses to start when that name appears there.
- **Declarative compatibility patches** - unique-anchor patches, re-applied at boot after a
  reinstall wipes them.
- **Drift repair with a circuit breaker** - keeps `baseURL` and listeners in sync, pauses
  when something else keeps rewriting the same value.
- **Host contract probe** - tries three registration shapes and records which one worked.
- **Bilingual UI** - follows the browser language (zh / en).

## Install

Requires **Node >= 20**, **DSH desktop >= 0.2.1-rc.2**, and `pnpm`.

```powershell
# Windows
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add dsh-egress-router        # or: pnpm add file:F:\path\to\dsh-egress-router
```

```bash
# Linux / macOS
cd ~/.dsh/profiles/desktop
pnpm add dsh-egress-router        # or: pnpm add file:/path/to/dsh-egress-router
```

Add `"dsh-egress-router"` to `dsh.profile.bundles` in that `package.json`, restart DSH, then
open **Settings -> Plugins -> Egress Router**. Full steps: [docs/install.md](docs/install.md).

## Quick start

1. **Scan** - list model providers, Telegram, and other HTTPS targets found in config.
2. **Check** - compare direct vs. proxied; use **Find port** to get a free one.
3. **Pick a proxy** - `direct` or a name from `config.proxies` (e.g. `clash`).
4. **Apply** - rewrites `baseURL`, starts the listener, verifies once, rolls back on failure.
5. **Restart DSH** after the first apply or a port change.

## How it works

```
provider baseURL -> http://127.0.0.1:8792/... -> RelayManager (http.Server on 127.0.0.1)
                -> CONNECT tunnel -> upstream proxy (optional, e.g. clash) -> target
```

Routes live in `$DSH_HOME/storages/egress-router/state.json` (`version: 8`,
`schemaVersion: 1`), not in `cordis.patch.yml`; the config only carries `proxies`.

## API

`GET|POST http://127.0.0.1:<gui-port>/plugins/egress-router?op=<op>`

| op | method | purpose |
| --- | --- | --- |
| `state` | GET | everything the page needs (19 keys, locked by `test/api-surface.test.mjs`) |
| `discover` | GET | rescan targets |
| `probe` | POST | reachability; only discovered targets, private addresses refused |
| `plan` | POST | diff / port / warnings, writes nothing |
| `ports` | GET | batch port availability |
| `suggest` | POST | pick a free port |
| `apply` | POST | listen -> write `baseURL` -> verify, rollback on failure |
| `rollback` | POST | undo by item or the last change |
| `test` | POST | one real request through the relay |
| `patches` / `patch` | GET / POST | compatibility patches: list / apply / revert / verify |
| `bot` | POST | set a bot's proxy (injected into the process environment) |
| `reconcile` | POST | repair config drift, or resume checking |

Write operations require `POST` with `content-type: application/json`. Common errors:
`invalid_port`, `port_in_use`, `provider_not_found`, `not_patchable`, `private_target`,
`unknown_target`, `unknown_proxy`, `apply_unverified`, `listener_failed`,
`file_changed_since_backup` (409), `no_backup`, `stale_plan` (409), `invalid_tuning`,
`unauthorized` (403), `reconcile_paused` (409).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Account profile unavailable", "plugin catalogue failed" | a global `HTTPS_PROXY` points at a proxy that is not running | remove it from `$DSH_HOME/.env` and proxy per target here |
| "接口不可用: Unexpected end of JSON input" | empty response from the plugin API | fully quit and restart DSH; the page also shows a contract-degraded notice |
| `port ... is already in use` | port taken | **Find port** and apply again |
| "target unreachable, rolled back" | upstream proxy down / blocked / wrong target | **Check** first; `/__health` on the relay port |
| "host accepted none of the known API registration shapes" | host contract changed | routing keeps working; report `state.hostContract` in an issue |
| config keeps being rewritten | host and plugin correcting each other | yellow bar -> **Resume checking**; 3 repairs within 60s pauses for 10 minutes |
| Telegram bot cannot connect | its transport only reads process env | pick a proxy on that row -> **Use this proxy**, then restart |
| applied but no effect | port/target change needs a new listener | restart DSH |

## Compatibility

| Host | Platform | Status |
| --- | --- | --- |
| DSH desktop `0.2.1-rc.2` | Windows 11 (Node 24) | **tested** |
| DSH desktop `0.2.0-rc.2` | Windows / Linux | not tested (the probe tries three shapes) |
| other `0.2.x` | Windows / Linux | not tested; degrades explicitly |

Linux is covered in CI (`.github/workflows/ci.yml`: Windows/Linux x Node 20/24 - syntax check,
tests, package gate). See [docs/compatibility.md](docs/compatibility.md) for the matrix and the
upgrade checklist, and [docs/rollback.md](docs/rollback.md) for going back a version.

## Safety

- Binds `127.0.0.1` only.
- Writes need a JSON POST with same-origin intent; no `Access-Control-*` is ever returned, so
  cross-origin writes are stopped by the browser's preflight.
- Protected targets (`platform.deepseek.com`, `api.deepseek.com`, `registry.npmjs.org`, the
  plugin catalogue) are shown but not editable: proxying the things that publish, install and
  authenticate only widens the blast radius.
- Backups, post-write parse validation, and restore on failure; patches require a unique anchor.

## Limits

- Cannot change the HTTP client inside another plugin; such targets need a patch or upstream
  support.
- HTTP/1.1 only: no HTTP/2 cleartext upgrade, no SOCKS, no PAC.
- Upstream must be an unauthenticated `http://host:port` CONNECT proxy.
- p50/p95 samples live in memory and restart from zero.
- Compatibility patches are bound to a package version prefix; after a plugin upgrade the
  anchor may need an update (boot reports "anchor missing").

## Development

```bash
npm test               # 105 tests (custom runner: node --test workers hit EPERM in the sandbox)
npm run check          # node --check every module
npm run check:package  # package gate: required/forbidden files, size
npm run version        # version documented in README and CHANGELOG
```

## License

MIT
