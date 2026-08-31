# Verification gates

## Static

Static analysis covers source/type imports, dependency ranges, client graph declarations, and generated artifacts. A pass means no known blocking finding; it does not execute project code.

## Build

Build and runtime verification require `--yes --install`. The CLI selects the package manager from lockfiles, synchronizes dependencies with dependency lifecycle scripts disabled, records the lockfile hash before and after, and verifies installed DSH/Cordis versions against `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`. Required peers must resolve and satisfy every declared range. Missing optional dependencies or peers are recorded as `optional-missing`; when installed, they must satisfy their ranges. It then runs declared scripts in this order: `typecheck`, `build`, `test`, `pack:check`, stopping at the first failure. Artifact verification requires a successful `build` or `pack:check`; `typecheck`/`test` alone do not pass this gate.

If dependency installation or resolution verification fails, stop before running project scripts. Review and retain package manifest and lockfile changes with the source migration.

## Runtime

Runtime verification:

1. packs the plugin from its repository;
2. creates a fresh temporary `DSH_HOME`;
3. initializes a web profile by adding the tarball through the target DSH CLI;
4. composes effective config with `--dump-config`;
5. performs a CLI activation smoke with `--help`.

The gate also checks the DSH CLI's exact target version, the created profile manifest, the installed package manifest, bundle activation, and the plugin's presence in the effective config. Successful exit codes alone are insufficient.

Use a built target Harness CLI through `--harness-root`, or pass `--dsh-command` explicitly. The temporary home is deleted only after a successful run unless `--keep-temp` is set.

## Behavior

Choose focused checks from the plugin contract: render the real UI, invoke each command, exercise settings, verify service availability, repeat activation/deactivation, check listener cleanup, and cover failure recovery. Record exact commands, screenshots, logs, or tests. This gate is deliberately not inferred by dsh-doctor.
