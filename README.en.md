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

Or run without installing:

```sh
npx @bruc3van/dsh-doctor diagnose
```

The default target is `$DSH_HOME/profiles/web`, falling back to `~/.dsh`. Use `--dsh-command /path/to/dsh` for a special installation or `--harness-root /path/to/deepseek-harness` for a source checkout.

---

## Plugin migration: 0.1.1 → 0.1.2

### migrate commands

Doctor ships a versioned `dsh-v0.1.1-rc.2 → dsh-v0.1.2-alpha.2` migration catalog and exposes three auditable stages:

```sh
# Stage 1: read-only analysis of source, type imports, manifest, client graph, and build artifacts
dsh-doctor migrate analyze /path/to/plugin \
  --from dsh-v0.1.1-rc.2 \
  --to dsh-v0.1.2-alpha.2 \
  --harness-root /path/to/deepseek-harness

# Stage 2: preview exact rewrites; add --yes to write and create timestamped backups
dsh-doctor migrate apply /path/to/plugin --safe \
  --harness-root /path/to/deepseek-harness
dsh-doctor migrate apply /path/to/plugin --safe --yes \
  --harness-root /path/to/deepseek-harness

# Stage 3: static, build, and isolated runtime verification in order
dsh-doctor migrate verify /path/to/plugin --level static \
  --harness-root /path/to/deepseek-harness
dsh-doctor migrate verify /path/to/plugin --level build --yes \
  --harness-root /path/to/deepseek-harness
dsh-doctor migrate verify /path/to/plugin --level runtime --yes \
  --harness-root /path/to/deepseek-harness
```

Run `dsh-doctor migrations list` to confirm the CLI contains this exact version pair before starting. Without a local install, `npx --package=@bruc3van/dsh-doctor dsh-doctor migrations list` works the same.

### Stage details

**analyze**: Uses the TypeScript AST so it sees type-only imports that disappear from JavaScript bundles. Also checks package metadata, client graph declarations, and build artifacts. A clean bundle alone does not imply compatibility.

**apply --safe**: Rewrites only catalog-confirmed exact-equivalent symbols, pins non-removed DSH development dependencies to the target version, and creates timestamped backups. It may add dependencies required by exact symbol moves but does not automatically change existing peer ranges. Session, Workspace, Conversation, and pending-interaction ownership changes are left as `MIG_SEMANTIC_API_CHANGE` and are never mechanically replaced.

**verify**:

| Level | What it does |
|---|---|
| `static` | Uses the TypeScript AST to inspect source/imports, manifest, client graph, and build artifacts without running project scripts |
| `build` | Executes plugin build scripts and verifies the artifact (`build` or `pack:check` must succeed; `test`/`typecheck` alone is insufficient proof of a publishable artifact) |
| `runtime` | Packs the real plugin tarball, installs it under a temporary `DSH_HOME` via the target CLI into a fresh web profile, verifies CLI version, profile manifest, installed package, activated bundle, effective config, and performs an activation smoke; never touches the normal `~/.dsh` |

The highest achievable gate is `analyzed` → `source-migrated` → `artifact-verified` → `runtime-verified`. `runtime-verified` still does not prove real UI, lifecycle, or business behavior. Failed workspaces are retained and reported; successful ones are cleaned up by default.

### Key API changes

`@deepseek-ai/dsh-client-runtime` was removed with **no aggregate replacement**. Capabilities migrate to:

| Concern | 0.1.2 owner | Migration |
|---|---|---|
| store engine and equality helpers | `dsh-client-store` | exact (catalog-listed symbols) |
| Cordis client context type | `@deepseek-ai/cordis` `Context` | exact; preserve local aliases |
| session control / list / commands | `dsh-api-session-controller/client` | semantic (developer judgment required) |
| workspace state / commands | `dsh-api-workspace-controller/client` | semantic |
| conversation assembly | `dsh-client-ui-conversation/client` | semantic |
| pending-interaction state | domain UI packages aggregated by `ui-session` | semantic |

`@deepseek-ai/dsh-host-apiproxy` was also removed with no compatible substitute. Browser operations use their natural generated Remote owners through API Remotes/API Gateway contributions.

### dsh-plugin-upgrade skill

The package ships the [`dsh-plugin-upgrade` skill](skills/dsh-plugin-upgrade/SKILL.md) so coding agents (such as Claude Code) can drive the full migration workflow without collapsing any safety gate. The skill triggers when a plugin developer asks for migration, compatibility assessment, API replacement, peer dependency updates, artifact rebuilds, or DSH 0.1.2 runtime verification.

Install it directly from the GitHub repository into a supported coding agent:

```sh
npx skills add bruc3van/dsh-doctor
```

The repository currently exposes one skill, so the `skills` CLI discovers and installs `dsh-plugin-upgrade`; add `--skill dsh-plugin-upgrade` to select it explicitly. This installs the agent skill, not a global DSH Doctor CLI. The skill checks the local CLI version and target catalog, performs a read-only registry update check with `npm view`, and pins one exact npx version for all three phases when the local CLI is missing, outdated, or lacks the catalog. A global install or update always requires explicit user authorization.

---

## Diagnosis

### Diagnosis model

`diagnose` composes the configuration from an empty tree in the same order as current DSH:

```text
bundle layers → profile cordis.patch.yml → home cordis.patch.yml → CLI overlays
```

The JSON report retains `currentDefaultTree`, `currentEffectiveTree`, field-level provenance, replaced sources, and paths removed by whole-`config` replacement. It diagnoses:

- stale patches, missing targets, wrong name assertions;
- duplicate entry ids and duplicate plugin mounts;
- higher-layer disabling, structural replacement, whole group/config overrides;
- bundle declaration conflicts with profile activation state;
- plugin versions, artifacts, client contracts, dependencies, and runtime issues.

Every `pluginDiagnoses[]` object keeps current `status` separate from `recovery`. Being removable does not make an incompatible plugin compatible.

```sh
dsh-doctor diagnose
dsh-doctor diagnose --json
dsh-doctor diagnose --check-updates
```

Only `--check-updates` and `recover` contact the npm registry. Offline diagnosis reports `update.status: "not-checked"` and never turns "not checked" into "no compatible version."

---

## Recovery decisions

### Compatible-version search

Doctor checks all published manifests instead of trusting `latest`, then selects the highest version whose declared peer ranges accept the resolvable active DSH packages. This is a manifest-declared candidate only, not proof from a real startup or UI test.

```sh
dsh-doctor recover @scope/plugin --action check-update
dsh-doctor recover @scope/plugin --action update       # preview
dsh-doctor recover @scope/plugin --action update --yes # exact version
```

### Quarantine

When no compatible release is available, generate and test a temporary overlay first:

```sh
dsh-doctor recover @scope/plugin --action quarantine
dsh-doctor recover @scope/plugin --action quarantine --output ./plugin-quarantine.yml
dsh --profile web --patch ./plugin-quarantine.yml
```

Doctor only generates an overlay when every active entry is precisely mapped, has a unique non-empty id and an exact name assertion, and the bundle does not rewrite entries owned by another layer. Core bundles, declared client dependents, and plugins statically detected as runtime Service providers with unproven dependents require manual review. The overlay disables all known active entries, causing both host and client sources to exit composition.

After testing the overlay, persistence is separately gated:

```sh
# Preview the exact diff first
dsh-doctor recover @scope/plugin --action persist-quarantine --verified

# Write to profile/cordis.patch.yml after explicit confirmation
dsh-doctor recover @scope/plugin --action persist-quarantine --verified --yes
```

Persistence appends the final winning profile-layer disable override and refuses the write when a home or CLI overlay would still outrank it. It then recomposes the configuration and verifies every exact target is disabled; failed verification returns a nonzero exit code. The write rechecks SHA-256 and atomically replaces the profile patch. An existing patch gets a `.dsh-doctor-<timestamp>.bak`; a first-time file gets a `.rollback.json` containing its target and created-content hash, enabling deletion rollback only while the file is unchanged.

Preview and explicitly restore that backup or rollback record:

```sh
dsh-doctor recover @scope/plugin --action rollback-quarantine \
  --backup /path/to/cordis.patch.yml.dsh-doctor-...bak
dsh-doctor recover @scope/plugin --action rollback-quarantine \
  --backup /path/to/cordis.patch.yml.dsh-doctor-...bak --yes
```

Doctor only accepts timestamped recovery files belonging to the selected profile patch.

### Safe removal

Removal is always explicit and can never be inferred by legacy `--fix --yes`:

```sh
dsh-doctor recover @scope/plugin --action remove       # impact preview
dsh-doctor recover @scope/plugin --action remove --yes
```

Automatic removal requires a direct profile dependency, a readable lockfile, a non-core bundle, no manual mount or dangling patch that would remain, and a working current DSH CLI. Before the official command runs, Doctor saves a redacted diagnostic snapshot and quarantine overlay:

```sh
dsh plugin --profile web remove @scope/plugin
```

It then re-diagnoses dependency, bundle-layer, and active-entry absence and reports the exact rollback install command. Static analysis cannot prove the absence of dynamic Service dependencies, external data, or regressions in every real workflow. Restart the profile and validate its main functions after any bundle update or removal.

---

## Baselines

Save a baseline before upgrading, then compare plugin versions, compatibility state, Harness state, and finding changes afterwards:

```sh
dsh-doctor baseline create
dsh-doctor baseline compare

# Custom path
dsh-doctor baseline create --output ./before-upgrade.json
dsh-doctor baseline compare --output ./before-upgrade.json
```

The default baseline is `.dsh-doctor/baseline.json` inside the profile. It supplements current evidence and is never required for diagnosis.

## Legacy confirmed repairs

`--fix` and `--repair` remain compatible with deterministic 0.1.x install, update, and bundle-manifest repairs. They never quarantine or remove a plugin. File actions are hash-checked, backed up, and atomically replaced; commands use fixed argv and the selected `DSH_HOME`.

```sh
dsh-doctor --fix
dsh-doctor --fix --yes --json
```

---

## Output and exit codes

Text output supports Chinese and English. `--json` keeps stable English codes and complete non-secret evidence; plugin `config` values and other common secret fields are replaced with `[REDACTED]`.

| Exit code | Meaning |
|---|---|
| `0` | No blocking error, or an explicit action passed static verification |
| `1` | A possible startup blocker remains, or recovery verification is incomplete |
| `2` | Argument, environment, or action execution failure |

## Security boundaries

- Does not execute third-party plugins or evaluate `!!js`; diagnosis parses configuration structure but redacts every plugin `config` value plus other common secret fields from JSON, baselines, and recovery snapshots; text reports do not print configuration values.
- Registry compatibility is declarative only; it does not prove a real startup or UI test.
- Dynamic Service dependencies, external side effects, real UI behavior, and business workflows require user validation.
- Precise patch edits only operate on structures Doctor can safely parse and locate; ambiguous cases are refused automatically.
- After adding, updating, or removing a bundle, a running profile does not automatically change its bundle set — a restart is required.

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

Publishing uses GitHub Actions OIDC and npm provenance. Local implementation and verification do not commit, tag, or publish automatically.
