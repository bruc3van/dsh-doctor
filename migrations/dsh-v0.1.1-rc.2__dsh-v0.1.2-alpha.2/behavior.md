# DSH 0.1.1-rc.2 to 0.1.2-alpha.2 behavior migration

The old Client Runtime was split by ownership. There is no aggregate replacement package.

- Session control, list state, commands, projections, queue and event windows belong to `api-session-controller/client`.
- Workspace state and commands belong to `api-workspace-controller/client`; navigation policy belongs to `ui-workspace`.
- Conversation assembly belongs to `ui-conversation`; Chat and Trajectory own their respective projections.
- Approval and Question own their pending objects; `ui-session` only aggregates domain publications.
- The store engine belongs to `client-store`; React hook synthesis belongs to the renderer.
- The Host API Proxy was removed. Unary browser operations live on their natural Remote service owners.

An import move is safe only when the catalog marks it `exact`. A `semantic` mapping identifies the new owner but still requires the plugin developer to rewrite behavior and verify the real lifecycle.
