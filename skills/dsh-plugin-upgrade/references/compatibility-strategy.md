# Compatibility strategy

## Decide before changing the plugin

Moving a plugin to 0.1.2 and preserving 0.1.1 are different deliverables. The 0.1.2 catalog describes target migrations; it does not prove that the resulting source, dependency graph, artifact, or manifest still works on 0.1.1.

Record one explicit intent:

| Intent | Meaning | Write policy |
| --- | --- | --- |
| `0.1.2-only` | The next plugin release may drop 0.1.1 | Follow the catalog migration after preview and authorization |
| `dual-version` | The same release must support both 0.1.1 and 0.1.2 | Design the compatibility mechanism and two-version verification matrix before editing |
| `pending developer decision` | The developer has not chosen | Read-only analysis only; stop before apply, edits, installs, build, or runtime execution |

Do not treat general write authorization as permission to drop an older runtime. If the request does not settle the choice, ask the developer directly.

## Assess whether one release can support both

For `dual-version`, inventory each migration finding and determine whether the old and new owners coexist:

- static imports of packages that exist in only one DSH version;
- changed Service names, snapshot shapes, lifecycle, or event behavior;
- client graph `inject`, `external`, platform modules, and client exports;
- peer, optional peer, development, and bundled dependency ranges;
- patch targets and profile entries that differ between Harness versions;
- generated output that may capture version-specific imports.

Choose a repository-appropriate same-release mechanism based on evidence, such as a shared compatibility adapter with runtime feature detection or conditional version-specific entry points/builds inside the same package. Do not invent dynamic loading when the bundler or Harness activation model cannot support it. Do not publish a peer range that claims both versions until installation and runtime evidence supports that range.

The safe codemod is intentionally target-oriented. In dual-version mode, preview its changes only after the decision is recorded and review each proposed import and dependency edit against 0.1.1 before applying it. Semantic migrations always require the same cross-version review.

If the same release cannot load because required packages or static graph declarations are mutually exclusive, report the exact conflict. Ask the developer whether to change scope to separate plugin releases or accept a 0.1.2-only release. Neither alternative satisfies the original same-release `dual-version` intent.

## Verify a two-version matrix

Use exact Harness versions or checkouts and keep evidence separate:

| Gate | DSH 0.1.1 | DSH 0.1.2 |
| --- | --- | --- |
| dependency installation and peer resolution | required | required |
| typecheck/build/test and packed artifact inspection | required | required |
| isolated profile install and activation smoke | required | required |
| plugin-specific UI, Service lifecycle, commands, settings, and cleanup | required where applicable | required where applicable |

The current migration catalog and `migrate verify` target 0.1.2. They do not independently certify the legacy row. Verify 0.1.1 with the plugin repository's supported scripts and an isolated profile using the actual 0.1.1 Harness CLI. Preserve failure workspaces and report the exact commands, versions, artifacts, logs, or screenshots for each row.

Use precise conclusions:

- `0.1.2 runtime-verified; 0.1.1 not tested` is not dual-compatible.
- Passing builds on both versions is not runtime or behavior proof.
- Claim `dual-version` compatibility only after all required matrix rows pass for the same release artifact or for the explicitly documented version-specific artifact strategy.
