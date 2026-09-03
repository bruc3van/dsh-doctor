# Migration map

## Ownership split

`@deepseek-ai/dsh-client-runtime` was removed without an aggregate replacement.

| Old concern | 0.1.2 owner | Migration policy |
| --- | --- | --- |
| store engine and equality helpers | `@deepseek-ai/dsh-client-store` | exact for catalog-listed symbols |
| Cordis client context type | `@deepseek-ai/cordis` `Context` | exact; preserve local aliases |
| session control/list/commands | `@deepseek-ai/dsh-api-session-controller/client` | semantic |
| workspace state/commands | `@deepseek-ai/dsh-api-workspace-controller/client` | semantic |
| conversation assembly | `@deepseek-ai/dsh-client-ui-conversation/client` | semantic |
| approval/questions pending state | domain UI packages aggregated by `ui-session` | semantic |

Session snapshots no longer own Conversation views or all pending-interaction facts. Workspace navigation policy is distinct from workspace state. Check callers and lifecycle rather than changing import paths alone.

## Host facade removal

`@deepseek-ai/dsh-host-apiproxy` was removed. Browser operations use their natural generated Remote owners through API Remotes/API Gateway contributions. There is no facade-compatible package substitution.

## Settings registration

`@deepseek-ai/dsh-settings` remains, but its `settingsNamespace` factory export was removed in 0.1.2-alpha.2. This is a semantic Service migration, not an import move: inject the `settings` Service and register the plugin namespace through `ctx.settings.register(name, schema)`. Keep `SettingsConflictError` or other exports that still exist, and verify every namespace read path against the provider API (for example `describe`) instead of assuming the former factory object's methods still exist.

## Packages removed after alpha.3

`@deepseek-ai/dsh-tool-subagent-report` was removed: child reporting and parent follow-up were unified into one Steer messaging operation. The runtime surface is `SubagentRuntime.sendMessage` over one adjacent parent/child edge, and the model-facing adapters live in `@deepseek-ai/dsh-tool-subagent-control`. A plugin that bundled or extended the report tool needs a semantic rewrite against that operation; there is no drop-in replacement package.

`@deepseek-ai/dsh-code-runtime-python` was renamed to `@deepseek-ai/dsh-experimental-code-runtime-python` when the package moved to the experimental tier. Update module specifiers and dependency names together, then confirm with the developer that depending on an experimental-tier package is acceptable for the plugin's support posture; do not treat the rename as a silently compatible change.

## Client graph

- `dsh.client.inject` declares package dependency edges; Cordis service injection still controls activation.
- React, Cordis, client-store, ui-slots, and ui-primitives baseline modules are implicit and should not be repeated in `dsh.client.external`.
- A declared web client requires a published `exports["./client"]` artifact.

## Dependency ownership

An exact symbol move and its npm dependency placement are separate catalog decisions. The current target policy records Client relationships explicitly:

- Cordis must be present in matching `peerDependencies` and `devDependencies` for a client plugin;
- `dsh-client-store` and `dsh-session` Client/type relationships are development-only;
- existing published peer ranges are not widened automatically merely because a development dependency is pinned to the target catalog version.

Do not copy a replacement package into every dependency section that contained `dsh-client-runtime`. After apply, use the dependency verification gate to synchronize the lockfile and confirm the versions actually resolved in `node_modules`.

## Patch targets

For `MIG_PATCH_TARGET_CHANGED`, first confirm the Harness checkout is exact and its tag scan succeeded. Then compare the old and target web profile bundle patches: remove an obsolete override only when the old row disappeared without a replacement, or update the id when upstream deliberately renamed/moved the row. Do not guess a replacement id from a similar name.

The machine-readable source of truth ships with DSH Doctor. Confirm the installed CLI exposes the current catalog version pair declared in SKILL.md with `dsh-doctor migrations list`; the canonical catalog source is also available in the [DSH Doctor repository](https://github.com/bruc3van/dsh-doctor/tree/master/migrations), under the directory named after that pair. Catalogs older than the current pair remain historical evidence, not the current default.
