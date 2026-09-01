# DSH 0.1.1-rc.2 to 0.1.2-alpha.3 behavior migration

The old Client Runtime was split by ownership. There is no aggregate replacement package.

- Session control, list state, commands, projections, queue and event windows belong to `api-session-controller/client`.
- Workspace state and commands belong to `api-workspace-controller/client`; navigation policy belongs to `ui-workspace`.
- Conversation assembly belongs to `ui-conversation`; Chat and Trajectory own their respective projections.
- Approval and Question own their pending objects; `ui-session` only aggregates domain publications.
- The store engine belongs to `client-store`; React hook synthesis belongs to the renderer.
- The Host API Proxy was removed. Unary browser operations live on their natural Remote service owners.
- The demo-only `dsh-agent-spine-demo` package and the SQLite session persistence package were removed by alpha.3; neither has a catalog-confirmed drop-in replacement.
- Alpha.3 adds the `dsh-session-turn-outline` package and extends session submission/load-through APIs. These additions do not justify mechanical rewrites of existing plugin behavior.

An import move is safe only when the catalog marks it `exact`. A `semantic` mapping identifies the new owner but still requires the plugin developer to rewrite behavior and verify the real lifecycle.
