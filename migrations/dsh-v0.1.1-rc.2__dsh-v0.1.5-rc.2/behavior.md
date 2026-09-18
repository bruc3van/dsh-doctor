# DSH 0.1.1-rc.2 to 0.1.5-rc.2 behavior migration

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

## Interval 0.1.2-rc.1 to 0.1.5-rc.2

Verified against both tags: no `@deepseek-ai/dsh-*` package was removed or renamed, and the plugin-facing entrypoints the 0.1.2 migration moves plugins onto (`dsh-settings`, `dsh-client-store`, `dsh-client-ui-session`, `dsh-client-ui-chat`, `dsh-sdk-minimal`, `dsh-webhook`) are unchanged. 0.1.3 never shipped a stable tag and 0.1.4 was skipped upstream.

- The web profile removed the patch entries `client-runtime`, `api-gateway`, `tool-subagent-report`, and `tool-str-replace-editor` (verified by scanning both refs' bundle patches; `api-gateway` the entry is gone even though the `dsh-api-gateway` package survives). A plugin overlay that patches one of these entry ids must be re-anchored to the surviving owner entry.
- 18 packages were added (session-format family with v0-to-v3 migrations, client file-upload and resources, client-ui sidebar packages, dockkit, open-in-app, http-proxy, chunked-list, package-manifest, tool-present, api-workspace-files, host-open-in-app). Additions never force a rewrite; adopt them only when the plugin needs the new capability.
- `dsh-client-connection` dropped `webServer` from its inject list; export signatures are unchanged. A plugin that injected `webServer` through this module must find the new owner itself.
- The CLI adds `--from-default-profile <name>` for creating custom profiles from shipped templates. Existing flags and the `profiles/<name>/package.json` layout are unchanged.
- Cordis stays at 4.0.2, so `--target-version 0.1.5-rc.2` pins only the DSH packages.

An import move is safe only when the catalog marks it `exact`. A `semantic` mapping identifies the new owner but still requires the plugin developer to rewrite behavior and verify the real lifecycle.
