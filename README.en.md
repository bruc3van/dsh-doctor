# DSH Doctor

[中文](README.md) | English

DSH Doctor is a diagnostic and recovery-decision tool for DSH upgrade incidents. For each plugin, it explains the incompatibility, the configuration layer that caused or amplified it, the preferred repair, and whether temporary isolation or removal can be proven safe enough to offer.

This is a community-maintained third-party tool, not an official DeepSeek project. Normal diagnosis is read-only and never loads or executes inspected plugin code.

## Install

Node.js `22.19+` or `24+` is required:

```sh
npm install --global @bruc3van/dsh-doctor
dsh-doctor diagnose
```

The default target is `$DSH_HOME/profiles/web`, falling back to `~/.dsh`. Use `--dsh-command /path/to/dsh` for a special installation or `--harness-root /path/to/deepseek-harness` for a source checkout.

## Diagnosis model

Version 0.4.0 composes the configuration from an empty tree in the same order as current DSH:

```text
bundle layers → profile cordis.patch.yml → home cordis.patch.yml → CLI overlays
```

The JSON report retains `currentDefaultTree`, `currentEffectiveTree`, field-level provenance, replaced sources, and paths removed by whole-`config` replacement. It diagnoses stale patches, duplicate ids and mounts, higher-layer disabling or replacement, bundle/profile conflicts, plugin versions and artifacts, client contracts, dependencies, and runtime issues.

Every `pluginDiagnoses[]` object keeps current `status` separate from `recovery`. Being removable does not make an incompatible plugin compatible.

```sh
dsh-doctor diagnose
dsh-doctor diagnose --json
dsh-doctor diagnose --check-updates
```

Only `--check-updates` and `recover` contact the npm registry. Offline diagnosis reports `update.status: "not-checked"`; it never turns “not checked” into “no compatible version.”

## Compatible-version search

Doctor checks all published manifests instead of trusting `latest`, then selects the highest version whose declared peer ranges accept the resolvable active DSH packages. This is only a manifest-declared candidate, not proof from a real startup or UI test.

```sh
dsh-doctor recover @scope/plugin --action check-update
dsh-doctor recover @scope/plugin --action update       # preview
dsh-doctor recover @scope/plugin --action update --yes # exact version
```

## Quarantine

When no compatible release is available, generate and test a temporary overlay first:

```sh
dsh-doctor recover @scope/plugin --action quarantine
dsh-doctor recover @scope/plugin --action quarantine --output ./plugin-quarantine.yml
dsh --profile web --patch ./plugin-quarantine.yml
```

Doctor only generates it when every active entry is mapped precisely, has a unique non-empty id and an exact name assertion, and the bundle does not rewrite entries owned by another layer. Core bundles, declared client dependents, and plugins statically detected as runtime Service providers with unproven dependents require manual review.

After testing the overlay, persistence is separately gated:

```sh
dsh-doctor recover @scope/plugin --action persist-quarantine --verified
dsh-doctor recover @scope/plugin --action persist-quarantine --verified --yes
```

Persistence appends the final winning profile-layer disable override and refuses the write when a home or CLI overlay would still outrank it. It then recomposes the configuration and verifies every exact target is disabled; failed verification returns a nonzero exit code. The write rechecks SHA-256 and atomically replaces the profile patch. An existing patch gets a `.dsh-doctor-<timestamp>.bak`; a first-time file gets a `.rollback.json` containing its target and created-content hash, allowing deletion rollback only while the file is unchanged.

Preview and explicitly restore that backup or rollback record with `recover <package> --action rollback-quarantine --backup <path>`, adding `--yes` to apply it. Doctor only accepts timestamped recovery files belonging to the selected profile patch.

## Safe removal

Removal is always explicit and can never be inferred by legacy `--fix --yes`:

```sh
dsh-doctor recover @scope/plugin --action remove       # impact preview
dsh-doctor recover @scope/plugin --action remove --yes
```

Automatic removal requires a direct profile dependency, a readable lockfile, a non-core bundle, no manual mount or dangling patch that would remain, and a working current DSH CLI. Before the official `dsh plugin --profile <name> remove <package>` command runs, Doctor saves a redacted diagnostic snapshot and quarantine overlay. It then re-diagnoses dependency, bundle-layer, and active-entry absence and reports the exact rollback install command.

Static analysis cannot prove the absence of dynamic Service dependencies, external data, or regressions in every real workflow. Restart the profile and validate its main functions after any bundle update or removal.

## Baselines

```sh
dsh-doctor baseline create
dsh-doctor baseline compare
dsh-doctor baseline create --output ./before-upgrade.json
```

The default baseline is `.dsh-doctor/baseline.json` inside the profile. It compares Harness state, package versions and compatibility, and introduced or resolved finding codes. It supplements current evidence; it is never required for diagnosis.

## Legacy confirmed repairs

`--fix` and `--repair` remain compatible with deterministic 0.1.x install, update, and bundle-manifest repairs. They never quarantine or remove a plugin. File actions are hash-checked, backed up, and atomically replaced; commands use fixed argv and the selected `DSH_HOME`.

## Output, exit codes, and boundaries

Text output supports Chinese and English. `--json` keeps stable English codes and complete non-secret evidence; plugin `config` values and other common secret fields are replaced with `[REDACTED]`.

- `0`: no blocking error, or an explicit action passed static verification;
- `1`: a possible startup blocker remains, or recovery verification is incomplete;
- `2`: argument, environment, or action execution failure.

Doctor does not execute third-party plugins or evaluate `!!js`. It parses configuration structure, but redacts every plugin `config` value plus other common secret fields from JSON, baselines, and recovery snapshots; text reports do not print configuration values. Registry compatibility is declarative only. Dynamic services, external side effects, real UI behavior, and business workflows require real user validation. Ambiguous YAML or plugin ownership causes an automatic action to be refused.

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

Publishing uses GitHub Actions OIDC and npm provenance. Local implementation and verification do not commit, tag, or publish automatically.
