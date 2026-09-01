# DSH Doctor

[中文](README.md) | English

DSH Doctor helps an agent diagnose and upgrade DeepSeek Harness plugins: identify API changes between releases, modify code where the migration is known, point out semantic changes that need developer judgment, then rebuild and verify the plugin.

The current focus is:

```text
DSH 0.1.1 → DSH 0.1.2
```

The project also diagnoses DSH profiles and installed plugins, checks for compatible versions, and performs safety checks before quarantine or removal.

> This is a community-maintained third-party project, not an official DeepSeek project. The migration scope remains DSH 0.1.1 → 0.1.2; the current known-latest catalog exactly covers `dsh-v0.1.1-rc.2` through `dsh-v0.1.2-alpha.3`. The older alpha.2 catalog remains as historical rules. When a newer 0.1.2 prerelease appears, inspect its delta before deliberately updating the catalog and skill.

## Upgrade a plugin with the skill

Install the repository's [`dsh-plugin-upgrade`](skills/dsh-plugin-upgrade/SKILL.md) skill:

```sh
npx skills add bruc3van/dsh-doctor
```

Then ask the agent from inside the plugin repository:

```text
Upgrade this plugin from DSH 0.1.1 to DSH 0.1.2.
Analyze compatibility first, modify the code, then complete build and runtime verification.
```

An upgrade request does not itself authorize dropping the old runtime. If the developer has not said, the skill explicitly asks whether the same upgraded plugin release must still support DSH 0.1.1 before any migration write, dependency installation, build, or runtime command. When compatibility must be preserved, the agent designs a dual-version approach first and verifies 0.1.1 and 0.1.2 separately; one successful 0.1.2 run is not dual-version evidence.

The skill reminds the agent to work in this order:

1. inspect the plugin root, Harness checkout, package manager, and available DSH Doctor;
2. analyze source, type imports, dependencies, manifest, client graph, patches, and build output;
3. confirm whether the upgraded release targets only 0.1.2 or must remain compatible with 0.1.1;
4. preview and apply code changes that are known to be equivalent under the selected compatibility strategy;
5. use the new API owners to handle semantic changes that require understanding the plugin;
6. rebuild the plugin and run static, build, and isolated runtime verification, covering both versions in dual-version mode;
7. report the compatibility intent, changed files, remaining work, backups, and the verification level actually reached.

`npx skills add` installs agent instructions only. It does not install DSH Doctor globally. The skill checks the local CLI and npm registry first. If the local version is unsuitable, it uses a pinned `npx` version by default and does not change the global npm installation.

After verification, the agent can follow the plugin repository's existing versioning and release process if requested. The skill itself does not commit or publish anything automatically.

## How it works

DSH Doctor has three parts:

- **Skill**: tells the agent which steps to follow, which actions need confirmation, and what to report;
- **CLI**: scans the plugin, lists problems, changes deterministic code, and runs verification;
- **Migration catalog**: records known package, API, Service, configuration, and behavior changes between the two DSH versions.

The workflow is:

```text
analyze
  → change deterministic code
  → agent handles semantic changes
  → rebuild
  → static verification
  → temporary-profile installation and activation
  → publish through the plugin's own release process
```

The CLI only auto-edits migrations marked `exact` by the catalog. Ownership and lifecycle changes involving Session, Workspace, Conversation, and pending interactions are reported as `MIG_SEMANTIC_API_CHANGE`. The agent must handle them in the context of the plugin instead of applying a mechanical replacement.

## Why versioned rules are needed

DSH 0.1.2 changes more than package versions:

- `@deepseek-ai/dsh-client-runtime` was removed and has no single aggregate replacement;
- store features moved to `dsh-client-store`;
- Session, Workspace, Conversation, and pending interactions moved to separate controllers or UI packages;
- `@deepseek-ai/dsh-host-apiproxy` was removed, so browser calls move to the appropriate business Remote;
- client graph, platform externals, exports, and some profile patch targets also changed.

The migration catalog stores source/target tags and Git commits together with package, symbol, Service, and configuration rules. With `--harness-root`, the CLI verifies the commits behind both tags and compares entry ids in the target web profile. This gives the agent concrete version differences instead of making it guess the new API.

## Coverage

| Area | How Doctor and the agent handle it |
|---|---|
| JS/TS imports, including type-only, aliased, and mixed imports | Analyzed with the TypeScript AST; symbols with a known equivalent can be rewritten |
| Removed or added DSH packages | Checked in source and manifest; dependencies are updated only when no remaining reference blocks the change |
| DSH/Cordis version ranges | Checks dependencies, devDependencies, and peerDependencies; existing peer ranges are not widened automatically |
| Session, Workspace, Conversation, and other semantic changes | Reports the new owner and reason; the agent modifies the business code |
| `dsh.client` and client exports | Checks inject, external, platform, immediately, and `exports["./client"]` |
| Harness patch targets | Compares old and new entries when an exact Harness checkout is available |
| Build output | Scans `lib`, `dist`, `build`, and `out` for old APIs |
| Plugin build | Runs existing typecheck, build, test, and pack:check scripts; build or pack:check is required for artifact verification |
| Installation and activation | Packs the real tarball and installs it into a fresh web profile under a temporary `DSH_HOME` |
| UI and business behavior | Not decided by Doctor; the agent or developer runs plugin-specific checks |

Source analysis uses the TypeScript AST and is cross-checked against the manifest, client graph, and build output. A bundle without an old string does not prove that source code is compatible, and a successful compile does not prove that the published artifact or runtime is compatible.

## Safety

- `diagnose`, `migrate analyze`, and static verification are read-only and do not load or execute the inspected plugin;
- `migrate apply` requires `--safe --plan-file`; preview only creates a new plan outside the plugin root, never overwrites an existing file, and persists the complete analysis plus every input-file hash; `--yes` applies only that same reviewed plan;
- only `exact` migrations are auto-edited; semantic changes are not guessed;
- SHA-256 is checked before writing, so a file changed after preview is rejected;
- existing files receive timestamped backups and are replaced atomically through a temporary file;
- build and runtime verification synchronize dependencies and execute plugin scripts, so they require explicit `--yes --install`; install lifecycle scripts are disabled and lockfile plus resolved-version evidence is recorded;
- runtime verification uses a temporary `DSH_HOME`, not the normal `~/.dsh`;
- JSON, baselines, and recovery snapshots redact plugin configuration and common secret/token/password/key fields;
- global CLI installation, persistent quarantine, plugin removal, and publishing are never performed automatically by the skill.

## Use the migration CLI manually

Node.js `^22.19.0` or `>=24.0.0` is required.

First confirm that the CLI contains the required migration:

```sh
npm exec --yes --package=@bruc3van/dsh-doctor@<selected-version> -- \
  dsh-doctor migrations list
```

### 1. Analyze

```sh
dsh-doctor migrate analyze /path/to/plugin \
  --from dsh-v0.1.1-rc.2 \
  --to dsh-v0.1.2-alpha.3 \
  --harness-root /path/to/deepseek-harness \
  --json
```

Analysis checks source, dependencies, manifest, client graph, patch targets, and existing build output without executing plugin code. `--from`/`--to` select the exact catalog that supplies API rules. Alpha.3 is the current default, so it needs no separate `--target-version`. If a newer 0.1.2 build is explicitly targeted before the catalog is updated, inspect the source delta from alpha.3 first, then use `--target-version` to control dependency ranges, safe-plan pins, and the runtime version check. The report keeps the catalog and actual targets separate.

### 2. Apply

```sh
# Preview
dsh-doctor migrate apply /path/to/plugin --safe \
  --plan-file /temporary/path/reviewed-migration-plan.json \
  --harness-root /path/to/deepseek-harness --json

# Write after confirmation
dsh-doctor migrate apply /path/to/plugin --safe --yes \
  --plan-file /temporary/path/reviewed-migration-plan.json \
  --harness-root /path/to/deepseek-harness --json
```

The plan must stay outside the plugin root so it is not analyzed as plugin input. Apply checks the plan digest, every analyzed input, and each edit's before/after hashes; source, manifest, or other analyzed-input changes require a new reviewed plan. Deterministic dependency edits use catalog-owned Client/Host and peer/dev policies instead of inheriting the removed package's dependency section. Every changed file receives a backup.

### 3. Verify

```sh
dsh-doctor migrate verify /path/to/plugin --level static \
  --harness-root /path/to/deepseek-harness --json
dsh-doctor migrate verify /path/to/plugin --level build --yes --install \
  --harness-root /path/to/deepseek-harness --json
dsh-doctor migrate verify /path/to/plugin --level runtime --yes --install \
  --dsh-command /path/to/dsh --json
```

| Level | What it checks |
|---|---|
| `static` | Rechecks source, manifest, client graph, patches, and artifacts |
| `build` | Synchronizes and verifies target dependencies and the lockfile, then runs build/test scripts and scans output again |
| `runtime` | After dependency and build gates, packs the real tarball and checks target DSH, installed package, bundle, and effective configuration in a temporary profile |

Verification states are:

```text
analyzed → source-migrated → artifact-verified → runtime-verified
```

`runtime-verified` means that packing, installation, and basic activation passed. It does not replace real UI, Service lifecycle, and business-flow testing.

## Diagnose DSH and installed plugins

Global installation:

```sh
npm install --global @bruc3van/dsh-doctor
dsh-doctor diagnose
```

Temporary use:

```sh
npx @bruc3van/dsh-doctor diagnose
```

The default target is `$DSH_HOME/profiles/web`, falling back to `~/.dsh`.

```sh
dsh-doctor diagnose
dsh-doctor diagnose --json
dsh-doctor diagnose --check-updates
```

Diagnosis composes configuration in DSH order:

```text
bundle layers → profile cordis.patch.yml → home cordis.patch.yml → CLI overlays
```

It checks plugin versions and peers, Node engines, installation and lockfile state, bundles and patches, client contracts, duplicate mounts, higher-layer overrides, and DSH CLI/Harness version drift. Normal diagnosis does not use the network. Only `--check-updates` and recovery operations contact the npm registry.

## Recovery operations

```sh
# Check and install the highest manifest-declared compatible version
dsh-doctor recover @scope/plugin --action check-update
dsh-doctor recover @scope/plugin --action update
dsh-doctor recover @scope/plugin --action update --yes

# Create a temporary quarantine overlay
dsh-doctor recover @scope/plugin --action quarantine \
  --output ./plugin-quarantine.yml

# Persist it only after testing the temporary overlay
dsh-doctor recover @scope/plugin --action persist-quarantine --verified
dsh-doctor recover @scope/plugin --action persist-quarantine --verified --yes

# Removal is always separate
dsh-doctor recover @scope/plugin --action remove
dsh-doctor recover @scope/plugin --action remove --yes
```

Before quarantine or removal, Doctor checks entry ownership, configuration layers, direct dependencies, core bundles, lockfile state, manual mounts, and known client dependents. Static checks cannot prove dynamic Service dependencies or external data safety, so restart the profile and test its main features afterwards.

You can also save and compare a baseline around an upgrade:

```sh
dsh-doctor baseline create
dsh-doctor baseline compare
```

## Output and exit codes

Text output supports Chinese and English. `--json` uses stable English codes and keeps redacted structured evidence.

| Exit code | Meaning |
|---|---|
| `0` | No blocker remains, or the action completed and passed its verification |
| `1` | Compatibility issues, semantic migration, or verification work remains |
| `2` | Argument, environment, or action-execution failure |

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

Tests cover the CLI, configuration composition, diagnosis, redaction, backups and write protection, AST migration, build gates, isolated runtime verification, and recovery operations. CI tests Node.js `22.19` and `24` on macOS, Ubuntu, and Windows.

Local development, the skill, and the CLI never commit, tag, or publish automatically.
