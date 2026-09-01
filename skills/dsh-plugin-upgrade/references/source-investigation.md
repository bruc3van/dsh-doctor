# Investigate the actual DSH source and installed runtime

Use this workflow whenever the plugin's declared or requested DSH version differs from a catalog reference, a semantic migration remains, or the developer asks what changed in DSH. The catalog is a starting point, not a substitute for checking the actual runtime and source.

## 1. Record the runtime actually in use

Keep these as separate facts:

- the DSH executable selected by PATH or an explicit command;
- the version printed by that executable;
- the DSH package installation backing the executable;
- the plugin's dependency, peer, optional-peer, and development ranges;
- the DSH packages resolved in the plugin lockfile and `node_modules`;
- the requested target version;
- the source and target refs used by the migration catalog.

On Windows, use read-only commands such as:

```powershell
Get-Command dsh -All
dsh --version
npm root --global
Get-Content "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\package.json"
```

On macOS or Linux:

```sh
command -v -a dsh
dsh --version
npm root --global
cat "$(npm root --global)/@deepseek-ai/dsh/package.json"
```

Also inspect `DSH_HOME`, the selected profile manifest and lockfile, the plugin's lockfile, and any project-local DSH package. Do not assume PATH, a running DSH process, the profile, and the plugin workspace all resolve the same version.

## 2. Locate or obtain a Harness checkout

Prefer, in order:

1. an explicit checkout supplied by the developer;
2. a nearby project checkout whose remote and refs can be verified;
3. source provenance recorded by the installed package or repository metadata;
4. an upstream checkout obtained only when network access and cloning/fetching are within the developer's authorization.

Record `git remote -v`, worktree status, `git rev-parse <ref>`, and whether the checkout contains both relevant refs. Do not switch, reset, clean, or update a developer's checkout merely to inspect another ref. Use `git show`, `git diff`, `git grep`, and `git ls-tree` against refs without changing the worktree. A dirty checkout can still be used for ref-based inspection; report that the worktree itself was not treated as target evidence.

## 3. Build the additional-version delta

When the plugin's actual source or requested target is not exactly the catalog pair, compare the missing interval separately. At minimum inspect:

```sh
git diff --name-status <actual-source-ref>..<actual-target-ref> -- packages apps
git diff <actual-source-ref>..<actual-target-ref> -- '**/package.json'
git grep -n '<old-symbol-or-service>' <actual-source-ref> -- packages apps
git grep -n '<old-symbol-or-service>' <actual-target-ref> -- packages apps
git grep -n '<new-owner-or-symbol>' <actual-target-ref> -- packages apps
git show <actual-target-ref>:<candidate-package>/package.json
```

Check package existence and exports, declaration files or TypeScript source, Service names and Cordis injection, snapshot shapes, event and cleanup lifecycles, client manifest rules, profile patches, build presets, and upstream architecture or migration notes. Do not infer an API from a similarly named package or symbol.

Classify every additional difference as:

- confirmed exact move;
- semantic behavior change;
- removed with no replacement;
- configuration or packaging change;
- unknown because source or evidence is unavailable.

Only the catalog-confirmed pair is eligible for the built-in safe codemod. Treat additional exact-looking changes as proposed manual edits until independently reviewed and tested.

After the additional interval is reviewed, pass that exact version as `--target-version` in analyze, apply preview/apply, and verify. This is an explicit fallback for a newer 0.1.2 build that the current alpha.3 catalog does not yet cover. It changes DSH dependency-range validation, deterministic DSH development pins, and the runtime version expectation; it does not turn the unlisted interval into catalog-confirmed API knowledge. Use `--dsh-command` to name the executable that actually reports and runs that version, and update the catalog and skill deliberately when that build becomes the new known target.

## 4. Investigate each semantic task in the plugin

Start from the finding's `file`, `symbol`, `targetModule`, `targetSymbol`, and `reason`. Then:

1. trace every caller and lifecycle owner in the plugin;
2. inspect the target package export and implementation at the exact target ref;
3. compare source and target snapshot/event shapes;
4. identify activation, subscription, cleanup, error, and recovery behavior;
5. decide whether one source tree can support both requested DSH versions;
6. propose the smallest behavior-preserving change and name the tests needed to prove it.

If the catalog reference paths in `migration.references` exist in the Harness checkout, read them at the target ref. They are supporting evidence, not a replacement for inspecting the actual exported API and the plugin's callers.

## 5. Report provenance and uncertainty

For each conclusion, report:

- actual installed/runtime version evidence;
- plugin manifest and resolved dependency evidence;
- checkout remote, refs, and commits;
- catalog-covered delta versus additionally inspected delta;
- exact source paths, symbols, or commands used;
- remaining unknowns and the developer decision they block.

Never call an unlisted version combination compatible merely because the catalog pair passed.
