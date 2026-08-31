---
name: dsh-plugin-upgrade
description: Help diagnose and upgrade a DeepSeek Harness plugin from DSH 0.1.1 to 0.1.2 with dsh-doctor, while deciding explicitly whether the upgraded release must remain compatible with DSH 0.1.1. Use when a plugin developer asks to assess compatibility, identify changed APIs, replace removed dsh-client-runtime or dsh-host-apiproxy usage, update DSH dependencies, modify plugin code, rebuild artifacts, or verify the plugin before releasing a new version. Apply only catalog-confirmed exact rewrites automatically, guide semantic code changes, and report what still needs developer verification. The current catalog uses dsh-v0.1.1-rc.2 and dsh-v0.1.2-alpha.2 as its reference points.
---

# Upgrade a DSH 0.1.1 plugin to 0.1.2

Help the developer diagnose and modify one plugin at a time. Treat source migration, artifact verification, runtime activation, and business behavior as separate gates.

The current migration knowledge covers the DSH 0.1.1 to 0.1.2 transition. Its CLI catalog records `dsh-v0.1.1-rc.2` and `dsh-v0.1.2-alpha.2` as the exact reference points used to derive and verify known changes. Use those refs in dsh-doctor commands, but first record the plugin's actual DSH ranges and requested target. When another patch or prerelease is involved, use the catalog for known changes only and report that the additional version difference still needs review. Do not claim that the catalog proves an unlisted version combination.

## Inputs

Determine:

- the plugin repository root;
- the DSH Harness checkout when available;
- the plugin's actual DSH dependency and peer ranges, and the requested 0.1.2 target;
- whether the upgraded plugin must keep supporting DSH 0.1.1, target only DSH 0.1.2, or still needs that decision from the developer;
- whether the developer authorizes writes and project command execution;
- whether the developer authorizes a global CLI install or update;
- the plugin's package manager and build scripts.

Use these catalog reference points in the current CLI commands:

- source: `dsh-v0.1.1-rc.2`
- target: `dsh-v0.1.2-alpha.2`

Read [cli-bootstrap.md](references/cli-bootstrap.md) before running any migration command, [compatibility-strategy.md](references/compatibility-strategy.md) before proposing or writing changes, [migration-map.md](references/migration-map.md) before making semantic changes, and [verification.md](references/verification.md) before build or runtime verification.

Before touching the plugin, inspect the local CLI and perform the read-only registry update check described in `cli-bootstrap.md`. Select one exact DSH Doctor version, verify it exposes this migration catalog, and keep the same invocation for analyze, apply, and verify. Prefer an exact-version `npx` fallback over changing the developer's global installation. Never globally install or update the CLI without explicit authorization.

The examples below use `dsh-doctor` for readability. When bootstrap selected an npx invocation, substitute the complete pinned prefix, `npx --yes --package=@bruc3van/dsh-doctor@<selected-version> dsh-doctor`, in every phase.

## Compatibility decision gate

An upgrade request does not say whether the developer accepts dropping DSH 0.1.1. Write authorization also does not answer that product decision. Do not infer the answer from the current peer range, the word "upgrade," or the fact that a 0.1.2-only rewrite is simpler.

You may inspect files, bootstrap the CLI, and run read-only analysis to collect evidence. Before any `migrate apply` preview, source or manifest edit, dependency install, build, or runtime command:

1. record an explicit choice already present in the developer's request; or
2. ask: **"Should the same upgraded plugin release continue to support DSH 0.1.1, or may it target DSH 0.1.2 only?"**

If the answer is unavailable or ambiguous, stop at `analyzed`, identify the compatibility decision as pending, and do not modify the plugin. Follow the selected path in [compatibility-strategy.md](references/compatibility-strategy.md):

- **0.1.2-only:** the catalog's exact rewrites may be applied after their normal preview and write confirmation.
- **dual-version:** treat every 0.1.2 rewrite as a candidate, not an automatically compatible change. Design and review an adapter or conditional entry/build approach before writing. If the same release cannot honestly support both versions, explain the conflict and ask whether separate releases are acceptable; that changes the compatibility intent and must not be presented as same-release dual compatibility.

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

Enter this phase only after the compatibility decision gate is resolved. The commands below are the 0.1.2-target migration path. For dual-version work, first apply the additional constraints in `compatibility-strategy.md`; do not assume a catalog-safe codemod is safe for 0.1.1.

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

For a dual-version result, verify the produced release against both the actual 0.1.1 and 0.1.2 environments. The catalog-driven `migrate verify` commands prove only the configured target side. Use the plugin's own build/test flow and an isolated 0.1.1 Harness profile for the legacy side, and name the evidence from each matrix row. A successful 0.1.2 runtime smoke must never be reported as dual-version compatibility.

## Prepare for release when requested

Verification prepares the plugin for release but does not publish it. If the developer explicitly asks to release the upgraded plugin, first follow the repository's own release instructions and confirm that required semantic and behavior checks are complete. Then update the plugin version and changelog, inspect the packed artifact, and use the repository's existing commit, tag, publish, and registry-verification workflow. Do not commit, tag, or publish merely because the migration skill was installed or run.

## Report the outcome

State the highest achieved gate exactly:

- `analyzed`
- `source-migrated`
- `artifact-verified`
- `runtime-verified`
- behavior verified separately with named evidence

Do not call the plugin compatible while errors, semantic tasks, stale artifacts, or required behavior checks remain. Include backups and retained temporary directories in the handoff.
Also report the selected DSH Doctor version and source (`local`, exact-version `npx`, or explicitly authorized global install), the registry version observed at bootstrap, and whether update status was current, outdated, missing, or unknown.
Report the plugin's actual source/target version evidence separately from the catalog reference refs. State whether the plugin is ready for its normal release process; if a release was explicitly requested and completed, include the commit, tag, registry, and release verification evidence.
State the compatibility intent as one of `0.1.2-only`, `dual-version`, or `pending developer decision`. For `dual-version`, report build, artifact, runtime, and behavior evidence separately for 0.1.1 and 0.1.2; only call the release dual-compatible when every required row passes.
