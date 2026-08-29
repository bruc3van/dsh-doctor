# DSH Doctor

[中文](README.md) | English

DSH Doctor helps DSH and plugin users quickly identify plugins that break startup or stop working after a DSH upgrade. It groups each plugin's problems, impact, and recommended actions, while also checking common profile configuration and version-drift issues. Diagnosis is read-only by default; repairs run only after you explicitly use `--fix`, review the exact plan, and confirm it. File edits are backed up first.

This is a community-maintained third-party tool and is not an official DeepSeek project. It does not load or execute code from the plugins it inspects.

## Installation

Node.js `22.19+` or `24+` is required:

```sh
npm install --global @bruc3van/dsh-doctor
dsh-doctor
```

You can also run it without a global installation:

```sh
npx @bruc3van/dsh-doctor
```

By default, Doctor checks `$DSH_HOME/profiles/web`. If `DSH_HOME` is unset, it uses `~/.dsh`.

Doctor does not require `dsh` to be installed as a global command. It searches, in order, an explicit `--dsh-command` or `DSH_DOCTOR_DSH_COMMAND`, the CLI under an explicit `--harness-root`, the shared profile installation or links left by the npx cache, the current project, PATH, and finally an automatically detected Harness source checkout. For a bundled DSH Desktop runtime or another custom installation, pass `--dsh-command /path/to/dsh`; the official package's `lib/bin.js` is also accepted. If no CLI can be found, Doctor still completes its read-only checks but does not offer or run command-based repairs that it cannot verify.

## How it works

A complete diagnosis and repair flow has four steps:

1. `dsh-doctor` inspects the active DSH Home, profile, plugins, and Harness versions without making changes.
2. Doctor reports evidence and recommendations by severity and plugin compatibility state.
3. `dsh-doctor --fix` shows the exact file edits or DSH command plan and waits for confirmation.
4. After applying confirmed repairs, Doctor runs the full diagnosis again and determines the exit code from the final state.

Doctor never loads inspected plugins and does not modify configuration during a normal diagnosis. Operations without one deterministic answer—such as guessing credentials, rewriting damaged YAML, or removing a plugin—remain recommendations only.

## Output language

Text output supports English and Chinese. Doctor resolves the language in this order:

1. `--lang zh|en`
2. `DSH_DOCTOR_LANG`
3. `locale.preference` in the active DSH Home's `settings.yaml`
4. Terminal or system locale

```sh
dsh-doctor --lang zh
dsh-doctor --lang en
DSH_DOCTOR_LANG=zh dsh-doctor
```

`--json` always keeps stable English messages and diagnostic codes so language changes do not break automation.

## Common commands

```sh
# Read-only diagnosis
dsh-doctor
dsh-doctor --profile web
dsh-doctor --home /path/to/.dsh
dsh-doctor --dsh-command /path/to/@deepseek-ai/dsh/lib/bin.js

# Machine-readable read-only report with no prompts
dsh-doctor --json

# Show a repair plan, apply it after confirmation, and diagnose again
dsh-doctor --fix

# Explicitly confirm the current plan in automation
dsh-doctor --fix --yes --json
```

`--repair` is an alias for `--fix`. `--yes` is valid only together with `--fix`.

## Plugin compatibility after a DSH upgrade

After DSH is updated, Doctor assigns every direct profile plugin one explicit state and summarizes the result in both text and JSON reports:

- `incompatible`: Doctor found an error that can prevent the plugin or Harness from loading, such as a missing plugin or an injection targeting a removed client runtime.
- `risk`: Doctor found a current-version risk, such as a Harness peer range that rejects the new version, a dependency on a removed DSH package, an unsupported Node.js version, or installation drift.
- `unknown`: The plugin does not declare a Harness compatibility range through `peerDependencies`, or the active package version for a declared peer cannot be resolved. Doctor cannot prove it supports the upgraded DSH, but does not report uncertainty as a failure.
- `compatible`: The declared compatibility ranges accept the active Harness and no plugin-related errors or warnings were found.

Compatibility checks cover every direct profile plugin, not only frontend plugins with `dsh.client`. References to removed Harness APIs in bundle-only or server-side plugins are reported as well. After upgrading DSH, run `dsh-doctor` first, review the exact update recommendations, and then decide whether to continue with `dsh-doctor --fix`.

## Current checks

- JSON root structure, dependency maps, bundle lists, and reload lifecycle in the profile `package.json`
- Syntax and top-level structure of profile, home, and bundle `cordis.patch.yml` files, including `!!js` expressions
- Safe structural checks for `settings.yaml` and `.credentials.yaml`; credential diagnostics never expose secret values
- Presence of profile dependencies, bundle declarations, patch files, and client bundles
- Consistency among the profile `package.json`, the `pnpm-lock.yaml` importer, and installed versions
- Node.js `engines`, Harness peer ranges, and obsolete DSH dependencies for all direct plugins, including bundle-only and server-side plugins
- Version drift and stale top-level `@deepseek-ai/dsh-*` packages across the active DSH CLI, Harness workspace, and profile
- The `platform`, `immediately`, `inject`, `external`, and `./client` export contract for `dsh.client`
- Consistency between literal `require()` calls in client bundles and external or module suppliers
- References to removed Harness client packages
- Third-party plugin peer ranges against actual active Harness versions
- Real resolution precedence where the Harness installation wins over a profile-local bundle with the same name
- Static composition of bundle, profile, and home patches in official Harness order, including missing targets, invalid group inserts, and name assertions, without loading plugins

## Repair safety

Every executable repair has a stable ID, risk level, description, and exact target:

- File repairs show their paths before confirmation and verify the SHA-256 fingerprint again before writing.
- Doctor creates a `.dsh-doctor-<timestamp>.bak` backup before replacing a file atomically through a temporary file in the same directory.
- External commands use fixed argument arrays and never construct shell commands.
- `--json --fix --yes` captures subprocess output in the repair result so stdout remains exactly one valid JSON document.
- Command repairs bind the diagnosed `DSH_HOME` and show the resolved CLI path instead of assuming `dsh` exists on PATH.
- Each command repair has a 10-minute limit; a timeout terminates that action and marks subsequent actions as skipped.
- A failed repair stops later actions and preserves backups already created.
- Doctor runs every diagnostic again after repairs and uses the final state for its exit code.

The initial release automatically performs only deterministic operations, such as restoring an installed bundle to the manifest list or running an exact profile install or update command. Damaged JSON or YAML, credential values, and plugin removal remain recommendations because Doctor cannot safely guess the intended result.

## Exit codes

- `0`: No blocking errors were found; warnings may still be present
- `1`: Doctor found a problem that may prevent Harness from starting
- `2`: Invalid arguments, an operational failure, or a failed repair

## Current limitations

- Static scanning recognizes only literal `require("package")` calls. Dynamic dependencies require a future bundle metadata contract.
- Configuration checks cover syntax and structures that Doctor can align deterministically. Patch composition follows the current Harness algorithm, but Doctor does not evaluate `!!js` or load third-party plugins.
- Version compatibility is based on plugin `peerDependencies` and resolvable active Harness package versions. A plugin without a declared range, or whose corresponding active version cannot be resolved, can receive only structural checks and an `unknown` compatibility state.
- Lockfile checks deterministically cross-check the direct profile importer only; they do not recursively scan the complete npm dependency graph.
- A runtime startup probe is not enabled. Even a copied `DSH_HOME` would not make arbitrary third-party plugin code side-effect-free because it could access the network, absolute paths, or external processes.

## Development

```sh
npm install
npm run check
node src/cli.mjs --help
```

The first publication of a new package must be performed by the npm account that owns the `@bruc3van` scope with `npm publish --access public`. Then configure a GitHub Actions Trusted Publisher in the npm package settings with Organization or user `bruc3van`, Repository `dsh-doctor`, Workflow filename `release.yml`, no Environment, and only the `npm publish` allowed action.

Before each later release, add a Chinese `## vX.Y.Z` entry matching the version tag to `CHANGELOG.md`. Pushing a tag that matches `package.json` makes the workflow publish through OIDC with npm provenance and automatically create or update the GitHub Release from that Chinese entry. The release fails if the entry is missing or contains no Chinese text. No long-lived npm token is required.
