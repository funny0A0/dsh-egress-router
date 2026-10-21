# dsh-egress-router

Per-endpoint loopback relay for DSH. Open a local port for *one* outbound target;
everything else keeps connecting directly.

DSH has a single transport answer per process (`@deepseek-ai/dsh-http-proxy`), so
setting `HTTPS_PROXY` routes the whole process through the proxy: when the proxy is
down, accounts, the plugin marketplace and pnpm installs all fail. This plugin moves
the proxy decision from the process level down to the target level.

## Install (local, private)

```powershell
cd C:\Users\<you>\.dsh\profiles\desktop
pnpm add file:F:\projects_all\AI_projects\dsh-egress-router
```

Add `dsh-egress-router` to `dsh.profile.bundles` in that `package.json`, then restart DSH.
The settings tab is **Plugins → Egress Router**.

## API

Single exact route `GET/POST /plugins/egress-router?op=state|discover|probe|apply|rollback`.

## Compatibility (0.7.0)

The host plugin contract is undocumented and has changed before, so this plugin probes it:
the endpoint is registered with `{kind:"exact"}`, then `{path, handler}`, then positionally;
the accepted shape is recorded in `state.hostContract`. Without `slots.inject` it falls back
to a direct `slots.register`. If no shape is accepted the plugin still loads (listeners and
state keep working) and the settings page simply has no API - an explicit degradation, never
a silent 404. See `docs/compatibility.md` for the tested-host matrix and the upgrade
checklist, and `docs/rollback.md` for returning to a previous version.

## Tests

```powershell
node test\run-all.mjs
```

(`node --test` spawns workers, which the DSH sandbox denies with `spawn EPERM`.)

## Limits

Cannot change transport inside other plugins' own clients; HTTP/1.1 only; upstream proxy
must be an HTTP CONNECT proxy.

## License

MIT
