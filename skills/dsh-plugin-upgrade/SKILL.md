---
name: dsh-plugin-upgrade
description: Upgrade a DeepSeek Harness plugin from dsh-v0.1.1-rc.2 to dsh-v0.1.2-alpha.2 with dsh-doctor. Use when a plugin developer asks to migrate, assess compatibility, replace removed dsh-client-runtime or dsh-host-apiproxy APIs, update DSH peer dependencies, rebuild artifacts, or verify a plugin against DSH 0.1.2. Produces an evidence-backed staged report and applies only catalog-confirmed exact rewrites automatically.
---

# DSH plugin upgrade

Upgrade one plugin at a time. Treat source migration, artifact verification, runtime activation, and business behavior as separate gates.
This skill is intentionally bound to the `dsh-v0.1.1-rc.2` to `dsh-v0.1.2-alpha.2` catalog; do not reuse its mappings for another version pair.

## Inputs

Determine:

- the plugin repository root;
- the DSH Harness checkout when available;
- whether the developer authorizes writes and project command execution;
- whether the developer authorizes a global CLI install or update;
- the plugin's package manager and build scripts.

Use these fixed refs unless the user explicitly requests a supported alternative:

- source: `dsh-v0.1.1-rc.2`
- target: `dsh-v0.1.2-alpha.2`

Read [cli-bootstrap.md](references/cli-bootstrap.md) before running any migration command, [migration-map.md](references/migration-map.md) before making semantic changes, and [verification.md](references/verification.md) before build or runtime verification.

Before touching the plugin, inspect the local CLI and perform the read-only registry update check described in `cli-bootstrap.md`. Select one exact DSH Doctor version, verify it exposes this migration catalog, and keep the same invocation for analyze, apply, and verify. Prefer an exact-version `npx` fallback over changing the developer's global installation. Never globally install or update the CLI without explicit authorization.

The examples below use `dsh-doctor` for readability. When bootstrap selected an npx invocation, substitute the complete pinned prefix, `npx --yes --package=@bruc3van/dsh-doctor@<selected-version> dsh-doctor`, in every phase.

## Phase 1: analyze

Run from any directory:

```sh
dsh-doctor migrate analyze <plugin-root> \
  --from dsh-v0.1.1-rc.2 \
  --to dsh-v0.1.2-alpha.2 \
  --json
```

Append `--harness-root <deepseek-harness-root>` when the checkout is available. Prefer an exact Harness checkout so the CLI verifies both tag commits. Both tags must exist and resolve to the commits recorded by the catalog; fetch the repository tags first when a shallow checkout lacks them. Without `--harness-root`, analysis is catalog-only and must be reported as such.

Group the result by:

1. errors blocking compatibility;
2. exact import moves eligible for safe codemods;
3. semantic tasks requiring developer judgment;
4. stale build artifacts;
5. required verification gates.

Do not infer compatibility from a clean bundled artifact alone. The analyzer intentionally scans TypeScript type imports, source files, package metadata, client graph declarations, and built output.

## Phase 2: apply exact changes

Preview first:

```sh
dsh-doctor migrate apply <plugin-root> --safe --harness-root <deepseek-harness-root> --json
```

Review affected files and hashes. Apply only with explicit authorization:

```sh
dsh-doctor migrate apply <plugin-root> --safe --yes --harness-root <deepseek-harness-root> --json
```

The CLI creates timestamped backups and refuses writes when a file changed after preview. It may split a mixed import: exact symbols move to their new owners while semantic symbols remain unresolved. It may pin non-removed DSH development dependencies and add dependencies required by exact symbol moves. It does not change the ranges of existing published peers automatically. Never mechanically replace the removed Client Runtime with one aggregate package; no such replacement exists.

After apply, inspect every `MIG_SEMANTIC_API_CHANGE`. Rewrite behavior using the new domain owner and its current snapshot/lifecycle contract. Keep these edits separate enough to review and test.

## Phase 3: verify

Run the gates in order:

```sh
dsh-doctor migrate verify <plugin-root> --level static --harness-root <deepseek-harness-root> --json
dsh-doctor migrate verify <plugin-root> --level build --yes --harness-root <deepseek-harness-root> --json
dsh-doctor migrate verify <plugin-root> --level runtime --yes --harness-root <deepseek-harness-root> --json
```

Build and runtime levels execute plugin scripts and therefore require `--yes`. Runtime verification packs the real plugin, creates a temporary `DSH_HOME`, installs into a new web profile, dumps effective config, and performs an activation smoke. It does not modify the developer's normal `~/.dsh`.

Resolve every semantic task and rebuild stale artifacts before expecting static verification to pass. An `apply` exit code of 1 after successful writes means migration blockers remain in the follow-up analysis; inspect `mode`, `writes`, and `report` instead of treating it as a write failure.

On failure, preserve and report the temporary directory. On success, the CLI removes it unless `--keep-temp` is used.

Runtime activation is not business-behavior proof. Finish with targeted manual or automated checks for visible UI, service lifecycle, event subscriptions, cleanup, configuration, and plugin-specific workflows.

## Report the outcome

State the highest achieved gate exactly:

- `analyzed`
- `source-migrated`
- `artifact-verified`
- `runtime-verified`
- behavior verified separately with named evidence

Do not call the plugin compatible while errors, semantic tasks, stale artifacts, or required behavior checks remain. Include backups and retained temporary directories in the handoff.
Also report the selected DSH Doctor version and source (`local`, exact-version `npx`, or explicitly authorized global install), the registry version observed at bootstrap, and whether update status was current, outdated, missing, or unknown.
