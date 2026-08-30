# DSH Doctor CLI bootstrap

Choose the CLI once before analysis so every migration phase uses the same implementation and catalog.

## 1. Inspect the environment

Confirm Node.js satisfies the package engine (`^22.19.0` or `>=24.0.0`). When `dsh-doctor` is available, run:

```sh
dsh-doctor --version
dsh-doctor migrations list --json
```

Record the local version and whether the exact `dsh-v0.1.1-rc.2` to `dsh-v0.1.2-alpha.2` catalog is present. A command that exists but lacks this catalog is not usable for this skill.

## 2. Check the registry without changing the machine

Query the official registry:

```sh
npm view @bruc3van/dsh-doctor version --registry=https://registry.npmjs.org
```

This is a read-only update check. If it fails because the registry is unavailable, report update status as `unknown`; do not describe the local CLI as current. An offline local CLI may still be used when it exposes the exact required catalog.

## 3. Select and pin one invocation

- When the local version equals the registry version and exposes the catalog, use `dsh-doctor` directly.
- When the local CLI is missing, differs from the registry version, or lacks the catalog, prefer the registry version through exact-version npx. First verify that version exposes the required catalog:

```sh
npx --yes --package=@bruc3van/dsh-doctor@<registry-version> dsh-doctor migrations list --json
```

- When the registry is unavailable, use the local CLI only if its catalog check passed.
- When neither candidate exposes the catalog, stop and report the missing prerequisite instead of guessing a compatible CLI.
- Respect an explicit developer request to use a particular local or development CLI, but still record its version and verify the catalog.

After selecting a version, replace `<registry-version>` with the resolved exact version in every npx command. Do not use `@latest` separately in analyze, apply, and verify because the resolved package could change during the migration.

## 4. Keep global installation separately authorized

The skill installation does not authorize system-wide npm changes. Only after the developer explicitly approves a global install or update may the agent run:

```sh
npm install --global @bruc3van/dsh-doctor@<selected-version>
```

Afterwards, re-run `dsh-doctor --version` and `dsh-doctor migrations list --json`. If either result differs from the selected version or required catalog, stop rather than falling back silently.

## 5. Preserve evidence

Include these fields in the handoff:

- local CLI version or `missing`;
- registry version or `unknown`;
- selected exact version and invocation source (`local`, `npx`, or authorized `global-install`);
- required catalog present or absent;
- update status: `current`, `outdated`, `missing`, or `unknown`.
