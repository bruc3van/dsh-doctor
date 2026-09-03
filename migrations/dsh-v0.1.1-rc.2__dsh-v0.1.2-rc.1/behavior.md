# DSH 0.1.1-rc.2 to 0.1.2-rc.1 behavior migration

The old Client Runtime was split by ownership. There is no aggregate replacement package.

- Session control, list state, commands, projections, queue and event windows belong to `api-session-controller/client`.
- Workspace state and commands belong to `api-workspace-controller/client`; navigation policy belongs to `ui-workspace`.
- Conversation assembly belongs to `ui-conversation`; Chat and Trajectory own their respective projections.
- Approval and Question own their pending objects; `ui-session` only aggregates domain publications.
- The store engine belongs to `client-store`; React hook synthesis belongs to the renderer.
- The Host API Proxy was removed. Unary browser operations live on their natural Remote service owners.
- The demo-only `dsh-agent-spine-demo` package and the SQLite session persistence package were removed; neither has a catalog-confirmed drop-in replacement.
- `dsh-tool-subagent-report` was removed after alpha.3: child reporting and parent follow-up were unified into one Steer messaging operation (`SubagentRuntime.sendMessage`, exposed to models through `tool-subagent-control`). Migrating a report-tool integration is semantic work, not an import move.
- `dsh-code-runtime-python` was renamed to `dsh-experimental-code-runtime-python` when the package moved to the experimental tier. The module rename is exact in shape, but the experimental placement is a support-level change the developer must accept deliberately.
- 0.1.2 adds the `dsh-session-turn-outline` package and extends session submission/load-through APIs. These additions do not justify mechanical rewrites of existing plugin behavior.

An import move is safe only when the catalog marks it `exact`. A `semantic` mapping identifies the new owner but still requires the plugin developer to rewrite behavior and verify the real lifecycle.
