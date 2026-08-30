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

## Client graph

- `dsh.client.inject` declares package dependency edges; Cordis service injection still controls activation.
- React, Cordis, client-store, ui-slots, and ui-primitives baseline modules are implicit and should not be repeated in `dsh.client.external`.
- A declared web client requires a published `exports["./client"]` artifact.

## Patch targets

For `MIG_PATCH_TARGET_CHANGED`, first confirm the Harness checkout is exact and its tag scan succeeded. Then compare the old and target web profile bundle patches: remove an obsolete override only when the old row disappeared without a replacement, or update the id when upstream deliberately renamed/moved the row. Do not guess a replacement id from a similar name.

The machine-readable source of truth ships with DSH Doctor. Confirm the installed CLI exposes this exact version pair with `dsh-doctor migrations list`; the canonical catalog source is also available in the [DSH Doctor repository](https://github.com/bruc3van/dsh-doctor/tree/master/migrations/dsh-v0.1.1-rc.2__dsh-v0.1.2-alpha.2).
