# DSH Doctor

[中文](README.md) | English

DSH Doctor is an upgrade and troubleshooting tool for DSH plugin developers and agents. It finds what needs to change during an upgrade, handles changes that are known to be safe, and then checks dependencies, build output, installation, and activation.

When a change depends on the plugin's business logic, Doctor calls it out for the agent or developer instead of guessing. Every edit is previewed and backed up first, and runtime checks use a temporary DSH environment rather than the developer's everyday profile.

> This is a community-maintained third-party project, not an official DeepSeek project. The current migration scope is DSH 0.1.1 → 0.1.2. The catalog exactly covers `dsh-v0.1.1-rc.2` → `dsh-v0.1.2-rc.1` and retains the alpha.2 and alpha.3 historical rules. Differences outside those catalogs still require a separate investigation and are not proven compatible by the catalog.

## What it helps with

| Scenario | What DSH Doctor provides |
|---|---|
| Upgrade a plugin | Scans source, dependencies, manifest, client graph, patches, and build output; applies exact catalog-confirmed migrations and leaves semantic work to the agent |
| Verify a migration | Runs static reanalysis, dependency synchronization, build/test scripts, real tarball packaging, and temporary-profile installation and activation checks |
| Diagnose a DSH environment | Checks profile layers, plugin versions and peers, lockfile, bundles, patches, client contracts, duplicate mounts, and DSH CLI/Harness version drift |
| Recover safely | Compares before/after baselines, checks compatible updates, generates and verifies quarantine overlays, and records dependency and configuration impact before removal |

Agents can orchestrate these capabilities through the skill, while other tools can integrate the same structured CLI workflows.

## Recommended: ask an agent to install and use the skill

Send this prompt to your agent:

```text
Install this skill: https://github.com/bruc3van/dsh-doctor, and tell me how to use it.
```

You can also install the repository's [`dsh-plugin-upgrade`](skills/dsh-plugin-upgrade/SKILL.md) skill manually:

```sh
npx skills add bruc3van/dsh-doctor
```

After installation, ask the agent from inside the plugin repository that needs migration:

```text
Adjust and verify this plugin so that it is compatible with DSH 0.1.2.
```

The skill guides the agent to:

1. establish the plugin, actual DSH installation, Harness checkout, package manager, and usable DSH Doctor;
2. analyze source, dependencies, configuration, patches, and existing artifacts;
3. confirm whether the upgraded plugin release targets only 0.1.2 or must remain compatible with 0.1.1;
4. preview and apply exact changes allowed by that compatibility strategy, then handle semantic migrations that require business context;
5. rebuild and report static, artifact, isolated-runtime, and business-behavior evidence separately;
6. commit or publish through the plugin repository's own process only when the developer explicitly requests it.

`npx skills add` installs agent instructions only; it does not install DSH Doctor globally. The skill checks the local CLI and npm registry first. If the local version is unsuitable, it runs a pinned version through `npm exec` without changing the global installation.

An upgrade request does not itself authorize dropping the old runtime. When compatibility intent is missing, the skill may perform read-only analysis but asks before migration writes, dependency installation, build, or runtime commands. Dual-version mode requires separate 0.1.1 and 0.1.2 evidence; one 0.1.2 smoke test is not dual-version proof.

## How it works

DSH Doctor has three parts that constrain one another:

- **Skill**: defines investigation steps, the compatibility decision, confirmation gates, and reporting standards for the agent;
- **CLI**: provides read-only analysis, safe edits, diagnosis, baselines, recovery, and staged verification;
- **Migration catalog**: stores exact DSH tags/commits and known package, symbol, Service, configuration, and behavior changes.

The plugin migration workflow is:

```text
investigate the actual environment
  → catalog-driven analysis
  → reviewed-plan exact changes
  → agent handles semantic changes
  → build and artifact verification
  → temporary-profile installation and activation
  → plugin business-behavior verification
```

DSH 0.1.2 changes more than package versions. Legacy owners such as `dsh-client-runtime` and `dsh-host-apiproxy` were split, while Session, Workspace, Conversation, pending interaction, and Settings capabilities moved to new controllers, UI packages, or Services. The CLI only auto-edits relationships marked `exact`; ownership, lifecycle, and business-call changes are reported as `MIG_SEMANTIC_API_CHANGE`.

With an exact Harness checkout, Doctor also verifies the commits behind the two catalog tags and compares entry ids in the target web profile. After the additional source interval has been investigated, `--target-version` can bind dependencies and runtime checks to a newer 0.1.2 target, but it does not extend the catalog's API claims.

## Core capabilities

| Area | How it is handled |
|---|---|
| JS/TS imports and named re-exports | Uses the TypeScript AST for type-only, aliased, and mixed imports; rewrites only known equivalent symbols |
| Removed packages and retained-package API changes | Checks source and manifest, preserves exports that still exist, and reports symbols that need semantic migration |
| DSH/Cordis version ranges | Checks dependencies, devDependencies, peerDependencies, and resolved versions; existing peer ranges are not widened automatically |
| `dsh.client` and client exports | Checks inject, external, platform, immediately, and `exports["./client"]` |
| Harness patch targets | Compares old and new bundle entries when an exact Harness checkout is available |
| Build output | Scans `lib`, `dist`, `build`, and `out` for source/artifact drift |
| Plugin build | Runs existing typecheck, build, test, and pack:check scripts; test/typecheck alone cannot establish artifact verification |
| Installation and activation | Packs the real tarball and installs it into a fresh web profile under a temporary `DSH_HOME` |
| Profile diagnosis | Composes bundle, profile, home, and CLI overlays in DSH order while preserving field provenance |
| Update, quarantine, and removal | Verifies versions, dependencies, configuration layers, and dependents before producing an explicit operation plan; updates, persistent quarantine, and removal need explicit confirmation |

No legacy string in source, a successful compile, an installable tarball, and correct business behavior are different evidence levels. Doctor does not present one as proof of another.

## Safety and evidence

- `diagnose`, `migrate analyze`, and static verification are read-only and do not load or execute the inspected plugin;
- only migrations marked `exact` by the catalog can be changed automatically; semantic changes are not guessed mechanically;
- `migrate apply` uses a reviewed plan outside the plugin root and binds the full analysis, actual target version, and every input-file hash;
- SHA-256 is rechecked before writes, input drift rejects the apply, and existing files receive timestamped backups;
- build/runtime commands require explicit confirmation and synchronize dependencies with lifecycle scripts disabled;
- runtime verification uses a temporary `DSH_HOME` instead of installing into the developer's normal `~/.dsh`;
- JSON, baselines, and recovery snapshots redact common secret, token, password, and key fields;
- global CLI installation, persistent quarantine, plugin removal, commits, and publication are never implicit actions.

## Boundaries

- Doctor can report a new API owner and migration reason, but it cannot replace understanding the plugin's business logic;
- named imports and named re-exports from retained packages are recognized, while property access through namespace imports still needs manual investigation;
- `runtime-verified` proves packaging, installation, and basic activation, not UI, Service lifecycle, or business-flow correctness;
- DSH patches or prereleases outside the catalog require investigation of the additional source interval;
- static diagnosis cannot establish dynamic Service dependencies or whether plugin-owned external data is safe to delete.

## CLI quick reference

Requires Node.js `^22.19.0` or `>=24.0.0`.

```sh
# Global installation
npm install --global @bruc3van/dsh-doctor

# Or run one pinned version without changing the global installation
npm exec --yes --package=@bruc3van/dsh-doctor@<version> -- dsh-doctor --help
```

| Command | Purpose |
|---|---|
| `dsh-doctor diagnose [--json] [--check-updates]` | Diagnose the current profile and installed plugins; normal diagnosis does not use the network |
| `dsh-doctor migrations list` | List the exact migration catalogs bundled with the current CLI |
| `dsh-doctor migrate analyze` / `apply` / `verify` | Analyze a migration, apply a reviewed plan, or run static/build/runtime verification |
| `dsh-doctor baseline create` / `compare` | Save or compare a redacted before/after diagnostic baseline |
| `dsh-doctor recover <package> --action <action>` | Check updates, generate/persist/roll back quarantine, or enter the separate removal workflow |

Use `dsh-doctor --help` for full options and confirmation requirements. Migration orchestration and semantic-investigation rules live in [`dsh-plugin-upgrade`](skills/dsh-plugin-upgrade/SKILL.md) and its references.

## Output and exit codes

Text output supports Chinese and English. `--json` uses stable English codes and preserves redacted structured evidence.

| Exit code | Meaning |
|---|---|
| `0` | No blocking error, or the operation completed and passed its verification level |
| `1` | Compatibility issues, semantic migration work, or incomplete verification remains |
| `2` | Argument, environment, or operation failure |

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

Tests cover the CLI, configuration composition, diagnosis, redaction, backups and write protection, AST migration, build gates, isolated runtime verification, and recovery. CI runs on macOS, Ubuntu, and Windows with Node.js `22.19` and `24`.

Local development, the skill, and the CLI never commit, tag, or publish automatically.
