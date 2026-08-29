import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import yaml from 'js-yaml'
import semver from 'semver'
import { parseDocument } from 'yaml'
import { languageName, localizedFinding } from './i18n.mjs'

export const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const BUILTIN_MODULES = new Set(builtinModules.map(name => name.replace(/^node:/, '')))

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 }
const JS_EXPRESSION = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: value => typeof value === 'string',
  construct: value => ({ __jsExpr: value }),
})
// Keep this dialect aligned with Harness entryListSchema: JSON values plus !!js.
const PATCH_SCHEMA = yaml.JSON_SCHEMA.extend([JS_EXPRESSION])

function objectRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function finding(severity, code, message, options = {}) {
  return {
    severity,
    code,
    message,
    ...options.package === undefined ? {} : { package: options.package },
    ...options.evidence === undefined ? {} : { evidence: options.evidence },
    ...options.details === undefined ? {} : { details: options.details },
    ...options.suggestion === undefined ? {} : { suggestion: options.suggestion },
    ...options.repair === undefined ? {} : { repair: options.repair },
  }
}

function readJson(file, subject, findings) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    findings.push(finding('error', 'FILE_READ_FAILED', `Cannot read ${subject}.`, {
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
    }))
    return undefined
  }
  try {
    const parsed = JSON.parse(text)
    if (objectRecord(parsed) === undefined) {
      findings.push(finding('error', 'INVALID_JSON_OBJECT', `${subject} must contain a JSON object.`, {
        evidence: file,
        suggestion: 'Restore a valid package manifest object before starting Harness.',
      }))
      return undefined
    }
    return parsed
  } catch (error) {
    findings.push(finding('error', 'INVALID_JSON', `${subject} is not valid JSON.`, {
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'Repair the JSON before starting this profile.',
    }))
    return undefined
  }
}

function packagePathParts(name) {
  if (typeof name !== 'string') return undefined
  if (name.startsWith('@')) {
    const parts = name.split('/')
    return parts.length === 2
      && /^@[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(parts[0])
      && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(parts[1])
      ? parts
      : undefined
  }
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ? [name] : undefined
}

function packageManifestAt(directory, expectedName, findings, source) {
  const file = join(directory, 'package.json')
  if (!existsSync(file)) return undefined
  const manifest = readJson(file, `${source} package manifest`, findings)
  if (manifest === undefined) return undefined
  if (manifest.name !== expectedName) {
    findings.push(finding('warning', 'PACKAGE_NAME_MISMATCH', `${source} resolves to a package named ${JSON.stringify(manifest.name)}.`, {
      package: expectedName,
      evidence: file,
      suggestion: 'Reinstall the dependency so its directory and package name agree.',
    }))
  }
  return { directory, file, manifest, requestedName: expectedName }
}

function findHarnessRoot(start) {
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))
      && existsSync(join(current, 'packages'))
      && existsSync(join(current, 'apps'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function executable(file) {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function regularFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function executableOnPath(name, env) {
  const path = env.PATH ?? env.Path ?? env.path ?? ''
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' ? `${name}${extension}` : name)
      if (executable(candidate)) return candidate
    }
  }
  return undefined
}

function manifestBin(packageDir) {
  const file = join(packageDir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (manifest?.name !== '@deepseek-ai/dsh') return undefined
    const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (typeof declared !== 'string') return undefined
    const bin = resolve(packageDir, declared)
    const rel = relative(packageDir, bin)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(bin) || !statSync(bin).isFile()) return undefined
    return { bin, version: manifest.version }
  } catch {
    return undefined
  }
}

function localDshPackage(start) {
  let current = resolve(start)
  while (true) {
    const packageDir = join(current, 'node_modules', '@deepseek-ai', 'dsh')
    if (manifestBin(packageDir) !== undefined) return packageDir
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function commandFromValue(value, env, cwd) {
  const expanded = value === '~'
    ? homedir()
    : value.startsWith('~/') || value.startsWith('~\\')
      ? resolve(homedir(), value.slice(2))
      : value
  const looksLikePath = isAbsolute(expanded) || expanded.includes('/') || expanded.includes('\\') || expanded.startsWith('.')
  const file = looksLikePath ? resolve(cwd, expanded) : executableOnPath(expanded, env)
  if (file === undefined) return undefined
  if (!regularFile(file)) return undefined
  if (/\.(?:c?js|mjs)$/i.test(file)) return { command: [process.execPath, file], path: file }
  return executable(file) ? { command: [file], path: file } : undefined
}

function resolveDshCli(options, harness, home) {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const explicit = options.dshCommand ?? env.DSH_DOCTOR_DSH_COMMAND
  if (explicit !== undefined) {
    const resolved = commandFromValue(explicit, env, cwd)
    if (resolved === undefined) throw new Error(`DSH command ${JSON.stringify(explicit)} does not exist or is not executable`)
    return { ...resolved, source: 'explicit' }
  }

  if (options.harnessRoot !== undefined && harness.root !== undefined) {
    for (const packageDir of [harness.root, join(harness.root, 'apps', 'cli')]) {
      const bin = manifestBin(packageDir)
      if (bin !== undefined) return { command: [process.execPath, bin.bin], path: bin.bin, source: 'checkout', version: bin.version }
    }
  }

  const sharedPackage = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(sharedPackage)) {
    const bin = manifestBin(realpathSync(sharedPackage))
    if (bin !== undefined) return { command: [process.execPath, bin.bin], path: bin.bin, source: 'profile', version: bin.version }
  }

  const localPackage = localDshPackage(cwd)
  if (localPackage !== undefined) {
    const bin = manifestBin(localPackage)
    return { command: [process.execPath, bin.bin], path: bin.bin, source: 'project', version: bin.version }
  }

  const pathCommand = executableOnPath('dsh', env)
  if (pathCommand !== undefined) return { command: [pathCommand], path: pathCommand, source: 'path' }

  if (harness.root !== undefined) {
    for (const packageDir of [harness.root, join(harness.root, 'apps', 'cli')]) {
      const bin = manifestBin(packageDir)
      if (bin !== undefined) return { command: [process.execPath, bin.bin], path: bin.bin, source: 'checkout', version: bin.version }
    }
  }
  return undefined
}

function workspacePackageDirectories(root) {
  const directories = []
  const addChildren = (parent) => {
    if (!existsSync(parent)) return
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(parent, entry.name))
    }
  }
  for (const group of ['packages', 'vendor']) {
    const groupRoot = join(root, group)
    if (!existsSync(groupRoot)) continue
    for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const first = join(groupRoot, entry.name)
      if (existsSync(join(first, 'package.json'))) directories.push(first)
      else addChildren(first)
    }
  }
  addChildren(join(root, 'apps'))
  return directories
}

function indexWorkspace(root, findings) {
  const packages = new Map()
  for (const directory of workspacePackageDirectories(root)) {
    const file = join(directory, 'package.json')
    if (!existsSync(file)) continue
    const manifestFindings = []
    const manifest = readJson(file, 'Harness workspace package manifest', manifestFindings)
    for (const item of manifestFindings) {
      findings.push(finding('warning', 'INVALID_WORKSPACE_MANIFEST', 'A Harness workspace package manifest was ignored because it is invalid.', {
        evidence: item.evidence ?? file,
        suggestion: 'Repair this workspace package manifest to include it in compatibility checks.',
      }))
    }
    if (typeof manifest?.name === 'string') packages.set(manifest.name, { directory, file, manifest })
  }
  return packages
}

function resolveHarnessContext(home, explicitRoot, findings) {
  if (explicitRoot !== undefined) {
    const root = resolve(explicitRoot)
    if (!existsSync(join(root, 'package.json')) || !existsSync(join(root, 'packages'))) {
      findings.push(finding('error', 'INVALID_HARNESS_ROOT', 'The configured Harness root is not a source checkout.', {
        evidence: root,
        suggestion: 'Pass the DeepSeek Harness repository root to --harness-root.',
      }))
      return { root, packages: new Map(), version: undefined, authoritative: false }
    }
    const manifest = readJson(join(root, 'package.json'), 'Harness root manifest', findings)
    return { root, packages: indexWorkspace(root, findings), version: manifest?.version, authoritative: manifest !== undefined }
  }

  const sharedDsh = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(sharedDsh)) {
    const canonical = realpathSync(sharedDsh)
    const root = findHarnessRoot(canonical)
    if (root !== undefined) {
      const manifest = readJson(join(root, 'package.json'), 'Harness root manifest', findings)
      return { root, packages: indexWorkspace(root, findings), version: manifest?.version, authoritative: true }
    }
    const manifest = readJson(join(canonical, 'package.json'), 'installed Harness manifest', findings)
    return { root: canonical, packages: new Map(), version: manifest?.version, authoritative: false }
  }

  findings.push(finding('warning', 'HARNESS_INSTALLATION_UNKNOWN', 'Could not locate the DSH installation currently used by this home.', {
    evidence: sharedDsh,
    suggestion: 'Pass --harness-root when diagnosing a source checkout.',
  }))
  return { root: undefined, packages: new Map(), version: undefined, authoritative: false }
}

function packageResolver(profileDir, home, harnessPackages, findings) {
  const cache = new Map()
  return (name) => {
    if (cache.has(name)) return cache.get(name)
    const parts = packagePathParts(name)
    if (parts === undefined) {
      cache.set(name, undefined)
      return undefined
    }
    const candidates = [
      join(profileDir, 'node_modules', ...parts),
      join(home, 'profiles', 'node_modules', ...parts),
    ]
    for (const candidate of candidates) {
      if (!existsSync(join(candidate, 'package.json'))) continue
      const resolved = packageManifestAt(candidate, name, findings, 'installed')
      cache.set(name, resolved)
      return resolved
    }
    const workspace = harnessPackages.get(name)
    const resolved = workspace === undefined ? undefined : { ...workspace, requestedName: name }
    cache.set(name, resolved)
    return resolved
  }
}

function bundleResolver(profileDir, home, harnessPackages, findings) {
  return (name) => {
    const workspace = harnessPackages.get(name)
    if (workspace !== undefined) return workspace
    const parts = packagePathParts(name)
    if (parts === undefined) return undefined
    for (const candidate of [
      join(home, 'profiles', 'node_modules', ...parts),
      join(profileDir, 'node_modules', ...parts),
    ]) {
      if (!existsSync(join(candidate, 'package.json'))) continue
      return packageManifestAt(candidate, name, findings, 'bundle')
    }
    return undefined
  }
}

function clientExport(manifest) {
  const value = manifest?.exports?.['./client']
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    if (typeof value.default === 'string') return value.default
  }
  return undefined
}

function dependencyEntries(value, field, file, findings, packageName) {
  if (value === undefined) return []
  const record = objectRecord(value)
  if (record === undefined || Object.values(record).some(item => typeof item !== 'string')) {
    findings.push(finding('error', 'INVALID_DEPENDENCY_MAP', `${field} must be an object of package names to string ranges.`, {
      package: packageName,
      evidence: file,
      suggestion: `Repair ${field} before managing or starting this profile.`,
    }))
    return []
  }
  return Object.entries(record)
}

function updateRepair(profile, name, commandRepair) {
  if (packagePathParts(name) === undefined) return undefined
  return commandRepair(
    `update-package:${name}`,
    `Update ${name} in profile ${profile}.`,
    ['plugin', '--profile', profile, 'update', name],
    { package: name, profile },
  )
}

function safePackageFile(packageDir, exported) {
  if (!exported.startsWith('./')) return undefined
  const file = resolve(packageDir, exported)
  const rel = relative(packageDir, file)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return file
}

export function extractStaticRequires(source) {
  const values = new Set()
  const code = codePositions(source)
  const pattern = /(?<![\w$.])require\s*\(\s*(['"])([^'"\\\r\n]+)\1\s*\)/g
  for (const match of source.matchAll(pattern)) {
    if (!code[match.index]) continue
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || BUILTIN_MODULES.has(specifier)) continue
    if (packagePathParts(specifier) !== undefined || specifier.startsWith('@')) values.add(specifier)
  }
  return [...values].sort()
}

function codePositions(source) {
  const code = new Uint8Array(source.length)
  let state = 'code'
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment'
        index += 1
      } else if (char === '/' && next === '*') {
        state = 'block-comment'
        index += 1
      } else if (char === "'" || char === '"' || char === '`') {
        state = char
      } else {
        code[index] = 1
      }
    } else if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code'
        code[index] = 1
      }
    } else if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code'
        index += 1
      }
    } else if (char === '\\') {
      index += 1
    } else if (char === state) {
      state = 'code'
    }
  }
  return code
}

function stripClientSuffix(specifier) {
  return specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier
}

function stringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined
}

function inspectClientPackage(record, context) {
  const {
    commandRepair, findings, harnessPackages, harnessPackagesAuthoritative, profile, resolvePackage,
  } = context
  const name = record.requestedName ?? record.manifest.name
  const disableSuggestion = `Upgrade ${name}; if no compatible release exists, remove it through the same DSH installation.`
  const declaration = record.manifest?.dsh?.client
  if (declaration === undefined) return
  if (declaration === null || typeof declaration !== 'object') {
    findings.push(finding('error', 'INVALID_CLIENT_DECLARATION', `${name} has an invalid dsh.client declaration.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
      repair: updateRepair(profile, name, commandRepair),
    }))
    return
  }

  if (typeof declaration.platform !== 'string') {
    findings.push(finding('error', 'INVALID_CLIENT_PLATFORM', `${name} dsh.client.platform must be a string.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
      repair: updateRepair(profile, name, commandRepair),
    }))
    return
  }
  if (declaration.immediately !== undefined && typeof declaration.immediately !== 'boolean') {
    findings.push(finding('error', 'INVALID_CLIENT_IMMEDIATELY', `${name} dsh.client.immediately must be a boolean.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
      repair: updateRepair(profile, name, commandRepair),
    }))
  }
  if (declaration.platform !== 'web') return

  const external = stringArray(declaration.external)
  const inject = stringArray(declaration.inject)
  if (declaration.external !== undefined && external === undefined) {
    findings.push(finding('error', 'INVALID_CLIENT_EXTERNAL', `${name} dsh.client.external must be a string array.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
      repair: updateRepair(profile, name, commandRepair),
    }))
  }
  if (declaration.inject !== undefined && inject === undefined) {
    findings.push(finding('error', 'INVALID_CLIENT_INJECT', `${name} dsh.client.inject must be a string array.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
      repair: updateRepair(profile, name, commandRepair),
    }))
  }

  const exported = clientExport(record.manifest)
  if (exported === undefined) {
    findings.push(finding('error', 'CLIENT_EXPORT_MISSING', `${name} declares dsh.client but exports no ./client entry.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
    }))
    return
  }
  const file = safePackageFile(record.directory, exported)
  if (file === undefined || !regularFile(file)) {
    findings.push(finding('error', 'CLIENT_BUNDLE_MISSING', `${name} client bundle is missing.`, {
      package: name,
      evidence: file ?? `${record.file}: exports["./client"] = ${JSON.stringify(exported)}`,
      suggestion: `Reinstall or rebuild ${name}; if it remains broken, remove it through the same DSH installation.`,
      repair: updateRepair(profile, name, commandRepair),
    }))
    return
  }

  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    findings.push(finding('error', 'CLIENT_BUNDLE_UNREADABLE', `${name} client bundle cannot be read.`, {
      package: name,
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
    }))
    return
  }

  const declared = new Set(external ?? [])
  for (const specifier of extractStaticRequires(source)) {
    if (PLATFORM_MODULES.has(specifier) || specifier === name || stripClientSuffix(specifier) === name) continue
    if (!declared.has(specifier)) {
      findings.push(finding('error', 'UNDECLARED_CLIENT_REQUIRE', `${name} requires ${specifier} but does not declare it in dsh.client.external.`, {
        package: name,
        evidence: file,
        suggestion: disableSuggestion,
        repair: updateRepair(profile, name, commandRepair),
      }))
    }
  }

  for (const specifier of declared) {
    if (PLATFORM_MODULES.has(specifier)) {
      findings.push(finding('warning', 'REDUNDANT_CLIENT_EXTERNAL', `${name} declares platform module ${specifier} as an external.`, {
        package: name,
        evidence: record.file,
        suggestion: 'The plugin author should remove this redundant dsh.client.external entry.',
      }))
      continue
    }
    const supplier = stripClientSuffix(specifier)
    const supplied = harnessPackagesAuthoritative
      ? harnessPackages.get(supplier)
      : harnessPackages.get(supplier) ?? resolvePackage(supplier)
    if (supplied === undefined || supplied.manifest?.dsh?.client === undefined) {
      findings.push(finding('error', 'CLIENT_EXTERNAL_WITHOUT_SUPPLIER', `${name} requests ${specifier}, but the active DSH has no client module supplier.`, {
        package: name,
        evidence: record.file,
        suggestion: disableSuggestion,
        repair: updateRepair(profile, name, commandRepair),
      }))
    }
  }

  if (harnessPackagesAuthoritative) {
    for (const dependency of inject ?? []) {
      if (!dependency.startsWith('@deepseek-ai/dsh-')) continue
      if (!harnessPackages.has(stripClientSuffix(dependency))) {
        findings.push(finding('error', 'REMOVED_CLIENT_INJECT', `${name} injects ${dependency}, which is absent from the active DSH.`, {
          package: name,
          evidence: record.file,
          suggestion: disableSuggestion,
          repair: updateRepair(profile, name, commandRepair),
        }))
      }
    }

  }
}

function inspectBundle(name, record, findings) {
  if (record === undefined) {
    findings.push(finding('error', 'BUNDLE_NOT_INSTALLED', `Profile bundle ${name} is not installed.`, {
      package: name,
      suggestion: 'Install the profile dependencies with the active DSH installation, upgrade the bundle, or remove it from the profile.',
    }))
    return undefined
  }
  const patch = record.manifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.length === 0) {
    findings.push(finding('error', 'BUNDLE_DECLARATION_MISSING', `${name} is listed as a profile bundle but declares no dsh.bundle.patch.`, {
      package: name,
      evidence: record.file,
      suggestion: 'Upgrade or remove this bundle from dsh.profile.bundles.',
    }))
    return undefined
  }
  const file = safePackageFile(record.directory, patch)
  if (file === undefined || !regularFile(file)) {
    findings.push(finding('error', 'BUNDLE_PATCH_MISSING', `${name} bundle patch is missing.`, {
      package: name,
      evidence: file ?? `${record.file}: dsh.bundle.patch = ${JSON.stringify(patch)}`,
      suggestion: 'Reinstall or upgrade this bundle, or remove it from the profile.',
    }))
    return undefined
  }
  const patches = inspectPatchFile(file, `${name} bundle patch`, findings, name)
  return patches === undefined ? undefined : { label: name, file, patches, package: name }
}

function inspectPatchFile(file, subject, findings, packageName) {
  let parsed
  try {
    parsed = yaml.load(readFileSync(file, 'utf8'), { schema: PATCH_SCHEMA })
  } catch (error) {
    findings.push(finding('error', 'INVALID_PATCH_YAML', `${subject} cannot be parsed.`, {
      package: packageName,
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'Repair the YAML syntax before starting this profile.',
    }))
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.some(item => objectRecord(item) === undefined)) {
    findings.push(finding('error', 'INVALID_PATCH_LIST', `${subject} must be a top-level YAML array of mappings.`, {
      package: packageName,
      evidence: file,
      suggestion: 'Repair the patch structure before starting this profile.',
    }))
    return undefined
  }
  let valid = true
  parsed.forEach((patch, index) => {
    if (patch.id !== undefined && typeof patch.id !== 'string') {
      valid = false
      findings.push(finding('error', 'INVALID_PATCH_ID', `${subject} entry ${String(index + 1)} has a non-string id.`, {
        package: packageName,
        evidence: file,
        suggestion: 'Use a string row id or omit id for a root insert patch.',
      }))
    }
    if (patch.name !== undefined && typeof patch.name !== 'string') {
      valid = false
      findings.push(finding('error', 'INVALID_PATCH_NAME', `${subject} entry ${String(index + 1)} has a non-string name assertion.`, {
        package: packageName,
        evidence: file,
        suggestion: 'Use a string plugin name assertion or omit the name field.',
      }))
    }
    if (patch.insert !== undefined
      && (!Array.isArray(patch.insert) || patch.insert.some(item => objectRecord(item) === undefined))) {
      valid = false
      findings.push(finding('error', 'INVALID_PATCH_INSERT', `${subject} entry ${String(index + 1)} insert must be an array of mappings.`, {
        package: packageName,
        evidence: file,
        suggestion: 'Repair the insert list before starting this profile.',
      }))
    }
  })
  return valid ? parsed : undefined
}

// Mirrors the current Harness applyEntryPatches control flow without importing
// code from (or executing code inside) the installation being diagnosed.
function inspectPatchComposition(layers, findings) {
  const entryMap = new Map()
  const indexEntries = (values) => {
    for (const entry of values) {
      if (typeof entry.id === 'string' && entry.id.length > 0) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) indexEntries(entry.config)
    }
  }
  for (const layer of layers) {
    layer.patches.forEach((patch, index) => {
      const evidence = `${layer.file}: entry ${String(index + 1)}`
      const hasInsert = patch.insert !== undefined
      if (hasInsert) {
        if (!Array.isArray(patch.insert)) return
        if (patch.id !== undefined) {
          const target = entryMap.get(patch.id)
          if (target === undefined) {
            findings.push(finding('warning', 'PATCH_TARGET_NOT_FOUND', `${layer.label} insert targets missing row ${patch.id}.`, {
              package: layer.package,
              evidence,
              suggestion: 'Check whether this overlay is intended for the selected profile and bundle order.',
            }))
            return
          }
          if (!target.group) {
            findings.push(finding('warning', 'PATCH_TARGET_NOT_GROUP', `${layer.label} inserts into row ${patch.id}, which is not a group.`, {
              package: layer.package,
              evidence,
              suggestion: 'Target a group row or use a root insert.',
            }))
            return
          }
          if (!Array.isArray(target.config)) target.config = []
          target.config.push(...structuredClone(patch.insert))
          indexEntries(target.config.slice(-patch.insert.length))
        } else {
          const inserted = structuredClone(patch.insert)
          indexEntries(inserted)
        }
        return
      }
      if (patch.id === undefined) {
        findings.push(finding('warning', 'PATCH_ID_REQUIRED', `${layer.label} has a non-insert patch without an id.`, {
          package: layer.package,
          evidence,
          suggestion: 'Add the target row id or turn the entry into an insert patch.',
        }))
        return
      }
      const target = entryMap.get(patch.id)
      if (target === undefined) {
        findings.push(finding('warning', 'PATCH_TARGET_NOT_FOUND', `${layer.label} targets missing row ${patch.id}.`, {
          package: layer.package,
          evidence,
          suggestion: 'Check whether this overlay is intended for the selected profile and bundle order.',
        }))
        return
      }
      if (patch.name !== undefined && patch.name !== target.name) {
        findings.push(finding('warning', 'PATCH_NAME_MISMATCH', `${layer.label} name assertion does not match row ${patch.id}.`, {
          package: layer.package,
          evidence: `${evidence}: expected ${JSON.stringify(target.name)}, got ${JSON.stringify(patch.name)}`,
          suggestion: 'Update the assertion or target the intended row.',
        }))
        return
      }
      for (const [key, value] of Object.entries(patch)) {
        if (key !== 'id' && key !== 'insert' && key !== 'name') target[key] = structuredClone(value)
      }
    })
  }
}

function inspectSettings(file, findings) {
  if (!existsSync(file)) return
  let root
  try {
    if (file.endsWith('.json')) root = JSON.parse(readFileSync(file, 'utf8'))
    else {
      const document = parseDocument(readFileSync(file, 'utf8'), { prettyErrors: true })
      if (document.errors.length > 0) {
        const positions = document.errors.map(error => {
          const at = error.linePos?.[0]
          return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
        })
        throw new Error(positions.join('; '))
      }
      root = document.toJS() ?? {}
    }
  } catch (error) {
    findings.push(finding('error', 'INVALID_SETTINGS_DOCUMENT', 'Harness settings cannot be parsed.', {
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'Repair the settings syntax; Doctor will not guess credential or model values.',
    }))
    return
  }
  if (objectRecord(root) === undefined) {
    findings.push(finding('error', 'INVALID_SETTINGS_ROOT', 'Harness settings must be a map of namespace sections.', {
      evidence: file,
      suggestion: 'Replace the root scalar or array with a mapping.',
    }))
  }
}

function inspectCredentials(file, findings) {
  if (!existsSync(file)) return
  let root
  try {
    const document = parseDocument(readFileSync(file, 'utf8'), { prettyErrors: true, uniqueKeys: true })
    if (document.errors.length > 0) {
      const positions = document.errors.map(error => {
        const at = error.linePos?.[0]
        return `${error.code}${at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`}`
      })
      throw new Error(positions.join('; '))
    }
    root = document.toJS() ?? {}
  } catch (error) {
    findings.push(finding('error', 'INVALID_CREDENTIALS_DOCUMENT', 'Harness credentials cannot be parsed.', {
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'Repair only the reported structure; Doctor never prints or rewrites secret values.',
    }))
    return
  }
  const fields = objectRecord(root)
  if (fields === undefined) {
    findings.push(finding('error', 'INVALID_CREDENTIALS_ROOT', 'Harness credentials must be a mapping.', { evidence: file }))
    return
  }
  const keys = Object.keys(fields)
  if (keys.length === 0) return
  if (fields.version !== 1 || keys.some(key => !['version', 'refs', 'records'].includes(key))) {
    findings.push(finding('error', 'INVALID_CREDENTIALS_LAYOUT', 'Harness credentials do not use the supported version 1 layout.', {
      evidence: file,
      suggestion: 'Migrate the document structure without exposing or changing its secret values.',
    }))
  }
}

function inspectPatchFileIfPresent(file, subject, findings) {
  return existsSync(file) ? inspectPatchFile(file, subject, findings) : undefined
}

function looksLikeSemverRange(value) {
  return /^(?:\s*[v=~^<>*]|\s*\d)/.test(value)
}

function inspectPluginNodeEngine(record, nodeVersion, findings) {
  const range = record.manifest?.engines?.node
  if (range === undefined) return
  const name = record.requestedName ?? record.manifest.name
  if (typeof range !== 'string' || semver.validRange(range) === null) {
    findings.push(finding('warning', 'INVALID_NODE_ENGINE_RANGE', `${name} declares an invalid Node.js engine range.`, {
      package: name,
      evidence: `${record.file}: engines.node = ${JSON.stringify(range)}`,
      suggestion: 'The plugin author should publish a valid engines.node range.',
    }))
    return
  }
  if (nodeVersion === undefined) return
  if (!semver.satisfies(nodeVersion, range, { includePrerelease: true })) {
    findings.push(finding('warning', 'PLUGIN_NODE_VERSION_MISMATCH', `${name} does not support the Node.js version used by the active DSH CLI.`, {
      package: name,
      evidence: `engines.node ${range} (active ${nodeVersion})`,
      suggestion: `Update ${name} or run DSH with a supported Node.js version.`,
    }))
  }
}

function lockedRegistryVersion(value) {
  if (typeof value !== 'string') return undefined
  const matched = value.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\(|$)/)?.[1]
  return matched !== undefined && semver.valid(matched) !== null ? matched : undefined
}

function inspectPnpmLock(profileDir, dependencyEntriesList, records, findings, commandRepair, profile) {
  const file = join(profileDir, 'pnpm-lock.yaml')
  const installRepair = () => commandRepair(
    `install-profile:${profile}`,
    `Install the declared dependencies for profile ${profile}.`,
    ['plugin', '--profile', profile, 'install'],
    { profile },
  )
  if (!existsSync(file)) return { file, present: false }
  let root
  try {
    const document = parseDocument(readFileSync(file, 'utf8'), { prettyErrors: true, uniqueKeys: true })
    if (document.errors.length > 0) throw new Error(document.errors.map(error => error.message).join('; '))
    root = document.toJS()
  } catch (error) {
    findings.push(finding('error', 'INVALID_PNPM_LOCKFILE', 'The profile pnpm lockfile cannot be parsed.', {
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'Run the exact profile install command after repairing or regenerating the lockfile.',
      repair: commandRepair(
        `install-profile:${profile}`,
        `Install the declared dependencies for profile ${profile}.`,
        ['plugin', '--profile', profile, 'install'],
        { profile },
      ),
    }))
    return { file, present: true, valid: false }
  }
  const importer = objectRecord(objectRecord(objectRecord(root)?.importers)?.['.'])
  const locked = importer?.dependencies
  const lockedDependencies = objectRecord(locked)
  if (lockedDependencies === undefined) {
    if (dependencyEntriesList.length === 0 && locked === undefined) {
      return { file, present: true, valid: true }
    }
    findings.push(finding('warning', 'PNPM_LOCKFILE_IMPORTER_MISSING', 'The profile pnpm lockfile has no usable root dependencies map.', {
      evidence: file,
      suggestion: 'Use the exact profile install command to reconcile the lockfile.',
      repair: installRepair(),
    }))
    return { file, present: true, valid: false }
  }
  const declaredNames = new Set(dependencyEntriesList.map(([name]) => name))
  for (const [name, declared] of dependencyEntriesList) {
    const entry = lockedDependencies[name]
    if (entry === undefined) {
      findings.push(finding('warning', 'LOCKFILE_DEPENDENCY_MISSING', `Profile dependency ${name} is absent from the pnpm lockfile importer.`, {
        package: name,
        evidence: file,
        suggestion: 'Use the exact profile install command to reconcile the manifest and lockfile.',
        repair: installRepair(),
      }))
      continue
    }
    const lockedEntry = typeof entry === 'string' ? { version: entry } : objectRecord(entry)
    const specifier = lockedEntry?.specifier
    if (typeof specifier === 'string' && specifier !== declared) {
      findings.push(finding('warning', 'LOCKFILE_SPECIFIER_MISMATCH', `Profile dependency ${name} has a different specifier in pnpm-lock.yaml.`, {
        package: name,
        evidence: `package.json ${declared} (lockfile ${specifier})`,
        suggestion: 'Use the exact profile install command to reconcile the manifest and lockfile.',
        repair: installRepair(),
      }))
    }
    const lockedVersion = lockedRegistryVersion(lockedEntry?.version)
    const installedVersion = records.get(name)?.manifest?.version
    if (lockedVersion !== undefined && typeof installedVersion === 'string'
      && semver.valid(installedVersion) !== null && installedVersion !== lockedVersion) {
      findings.push(finding('warning', 'LOCKFILE_INSTALLED_VERSION_MISMATCH', `Profile dependency ${name} does not match its locked version.`, {
        package: name,
        evidence: `locked ${lockedVersion} (installed ${installedVersion})`,
        suggestion: 'Use the exact profile install command to restore the locked installation.',
        repair: installRepair(),
      }))
    }
  }
  for (const name of Object.keys(lockedDependencies)) {
    if (declaredNames.has(name)) continue
    findings.push(finding('warning', 'LOCKFILE_DEPENDENCY_STALE', `pnpm-lock.yaml still lists undeclared profile dependency ${name}.`, {
      package: name,
      evidence: file,
      suggestion: 'Use the exact profile install command to remove stale lockfile importer entries.',
      repair: installRepair(),
    }))
  }
  return { file, present: true, valid: true }
}

function inspectRuntimeAlignment(harness, dshCli, findings) {
  // Harness release tooling uses the root manifest as the DSH release-family
  // baseline and bumps apps/cli plus the published members to the same version.
  if (typeof harness.version !== 'string' || typeof dshCli?.version !== 'string') return
  if (semver.valid(harness.version) === null || semver.valid(dshCli.version) === null) return
  if (harness.version === dshCli.version) return
  findings.push(finding('warning', 'DSH_CLI_HARNESS_VERSION_MISMATCH', 'The active DSH CLI and diagnosed Harness installation have different versions.', {
    evidence: `DSH CLI ${dshCli.version} (Harness ${harness.version})`,
    suggestion: 'Diagnose with the DSH CLI and Harness checkout used by the same installation.',
  }))
}

function inspectProfileHarnessPackages(profileDir, home, harness, findings) {
  const profileScope = join(profileDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(profileScope)) return
  let entries
  try {
    entries = readdirSync(profileScope, { withFileTypes: true })
  } catch (error) {
    findings.push(finding('warning', 'PROFILE_HARNESS_SCOPE_UNREADABLE', 'The profile-local @deepseek-ai package scope cannot be read as a directory.', {
      evidence: `${profileScope}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'Reinstall the profile with the active DSH CLI to repair its node_modules layout.',
    }))
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const name = `@deepseek-ai/${entry.name}`
    if (!name.startsWith('@deepseek-ai/dsh-') && name !== '@deepseek-ai/dsh') continue
    const profilePackage = join(profileScope, entry.name)
    const profileManifestFile = join(profilePackage, 'package.json')
    if (!existsSync(profileManifestFile)) continue
    let profileManifest
    try {
      profileManifest = JSON.parse(readFileSync(profileManifestFile, 'utf8'))
    } catch {
      continue
    }
    const sharedPackage = join(home, 'profiles', 'node_modules', '@deepseek-ai', entry.name)
    if (existsSync(join(sharedPackage, 'package.json'))) {
      try {
        if (realpathSync(profilePackage) !== realpathSync(sharedPackage)) {
          const sharedManifest = JSON.parse(readFileSync(join(sharedPackage, 'package.json'), 'utf8'))
          if (typeof profileManifest.version === 'string' && typeof sharedManifest.version === 'string'
            && profileManifest.version !== sharedManifest.version) {
            findings.push(finding('warning', 'DUPLICATE_HARNESS_PACKAGE_VERSION', `${name} exists in the profile and shared DSH installation at different versions.`, {
              package: name,
              evidence: `profile ${profileManifest.version} (${profilePackage}), shared ${sharedManifest.version} (${sharedPackage})`,
              suggestion: 'Reinstall the profile with the active DSH CLI so its module resolution uses one compatible version.',
            }))
          }
        }
      } catch {
        // Other manifest and filesystem checks report unreadable package state.
      }
    }
    if (harness.authoritative && !harness.packages.has(name)) {
      findings.push(finding('warning', 'STALE_PROFILE_HARNESS_PACKAGE', `${name} remains in the profile but is absent from the active DSH.`, {
        package: name,
        evidence: profileManifestFile,
        suggestion: 'Reinstall the profile with the active DSH CLI and review plugins that still require this package.',
      }))
    }
  }
}

function inspectCompatibility(record, context) {
  const {
    commandRepair, findings, harnessPackages, harnessPackagesAuthoritative, profile, resolvePackage,
  } = context
  const packageName = record.requestedName ?? record.manifest.name
  const peers = dependencyEntries(record.manifest.peerDependencies, 'peerDependencies', record.file, findings, packageName)
  const dependencies = dependencyEntries(record.manifest.dependencies, 'dependencies', record.file, findings, packageName)
  if (harnessPackagesAuthoritative) {
    const removedPeers = peers
      .map(([name]) => name)
      .filter(name => name.startsWith('@deepseek-ai/dsh-') && !harnessPackages.has(name))
      .sort()
    if (removedPeers.length > 0) {
      findings.push(finding('warning', 'LEGACY_HARNESS_PEERS', `${packageName} declares old interface packages that the active DSH has removed.`, {
        package: packageName,
        evidence: removedPeers.join(', '),
        suggestion: 'Update this plugin before relying on it with the current DSH release.',
        repair: updateRepair(profile, packageName, commandRepair),
      }))
    }
    const removedDependencies = dependencies
      .map(([name]) => name)
      .filter(name => name.startsWith('@deepseek-ai/dsh-') && !harnessPackages.has(name))
      .sort()
    if (removedDependencies.length > 0) {
      findings.push(finding('warning', 'LEGACY_HARNESS_DEPENDENCIES', `${packageName} depends on Harness packages that no longer exist in the active DSH.`, {
        package: packageName,
        evidence: removedDependencies.join(', '),
        suggestion: 'Update this plugin; its bundled DSH APIs may be incompatible with the current release.',
        repair: updateRepair(profile, packageName, commandRepair),
      }))
    }
  }
  const mismatches = []
  for (const [name, range] of peers) {
    if (!name.startsWith('@deepseek-ai/') && name !== 'cordis') continue
    if (semver.validRange(range) === null) {
      findings.push(finding('warning', 'INVALID_HARNESS_PEER_RANGE', `${packageName} declares an invalid Harness peer range for ${name}.`, {
        package: packageName,
        evidence: `${name}: ${range}`,
        suggestion: 'The plugin author should publish a valid peer dependency range.',
      }))
      continue
    }
    const supplier = harnessPackages.get(name) ?? resolvePackage(name)
    if (supplier === undefined) continue
    const version = supplier.manifest?.version
    if (typeof version !== 'string' || semver.valid(version) === null) continue
    if (semver.satisfies(version, range, { includePrerelease: true })) continue
    mismatches.push({ name, required: range, active: version })
  }
  if (mismatches.length > 0) {
    const grouped = new Map()
    for (const mismatch of mismatches) {
      const key = JSON.stringify([mismatch.required, mismatch.active])
      const group = grouped.get(key) ?? {
        required: mismatch.required, active: mismatch.active, packages: [],
      }
      group.packages.push(mismatch.name)
      grouped.set(key, group)
    }
    const groups = [...grouped.values()]
      .map(group => ({ ...group, packages: group.packages.sort() }))
    const evidence = groups.flatMap((group, index) => [
      ...(groups.length > 1 ? [`Group ${String(index + 1)}:`] : []),
      `${groups.length > 1 ? '  ' : ''}Plugin requires: ${group.required}`,
      `${groups.length > 1 ? '  ' : ''}Active DSH: ${group.active}`,
      `${groups.length > 1 ? '  ' : ''}Affected ${String(group.packages.length)} package(s): ${group.packages.join(', ')}`,
    ]).join('\n')
    findings.push(finding('warning', 'HARNESS_PEER_VERSION_MISMATCH', `${packageName} declares compatibility ranges that exclude the active DSH version.`, {
      package: packageName,
      evidence,
      details: { peerVersionGroups: groups },
      suggestion: `Update ${packageName} to a release compatible with the active DSH.`,
      repair: updateRepair(profile, packageName, commandRepair),
    }))
  }
}

function hasHarnessCompatibilityDeclaration(record) {
  const peers = objectRecord(record.manifest.peerDependencies)
  return peers !== undefined && Object.keys(peers)
    .some(name => name.startsWith('@deepseek-ai/') || name === 'cordis')
}

function pluginCompatibility(record, findings) {
  const name = record.requestedName ?? record.manifest.name
  const related = findings.filter(item => item.package === name)
  if (related.some(item => item.severity === 'error')) return 'incompatible'
  if (related.some(item => item.severity === 'warning')) return 'risk'
  if (!hasHarnessCompatibilityDeclaration(record)) return 'unknown'
  return 'compatible'
}

export function defaultDshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  if (configured !== undefined && configured.length > 0) {
    if (configured === '~') return homedir()
    if (configured.startsWith('~/') || configured.startsWith('~\\')) return resolve(homedir(), configured.slice(2))
    return resolve(configured)
  }
  return join(homedir(), '.dsh')
}

export function diagnose(options = {}) {
  const findings = []
  const home = resolve(options.home ?? defaultDshHome(options.env))
  const profile = options.profile ?? 'web'
  if (profile === '' || profile === '.' || profile === '..' || profile.includes('/') || profile.includes('\\')) {
    findings.push(finding('error', 'INVALID_PROFILE_NAME', `Invalid profile name ${JSON.stringify(profile)}.`))
    return finish({ home, profile, profileDir: undefined, harness: {}, packages: [] }, findings)
  }
  const profileDir = join(home, 'profiles', profile)
  const profileManifestFile = join(profileDir, 'package.json')
  if (!existsSync(profileManifestFile)) {
    findings.push(finding('error', 'PROFILE_NOT_FOUND', `Profile ${profile} does not exist.`, {
      evidence: profileDir,
      suggestion: 'Start the profile once or initialize it with the plugin install command from the same DSH installation.',
    }))
    return finish({ home, profile, profileDir, harness: {}, packages: [] }, findings)
  }
  const profileManifest = readJson(profileManifestFile, `profile ${profile} manifest`, findings)
  if (profileManifest === undefined) {
    return finish({ home, profile, profileDir, harness: {}, packages: [] }, findings)
  }

  const harness = resolveHarnessContext(home, options.harnessRoot, findings)
  const dshCli = resolveDshCli(options, harness, home)
  let commandRepairNeeded = false
  const commandRepair = (id, description, args, metadata = {}) => {
    commandRepairNeeded = true
    return dshCli === undefined ? undefined : {
      id,
      kind: 'command',
      risk: 'medium',
      description,
      command: [...dshCli.command, ...args],
      env: { DSH_HOME: home },
      ...metadata,
    }
  }
  const resolvePackage = packageResolver(profileDir, home, harness.packages, findings)
  const resolveBundle = bundleResolver(profileDir, home, harness.packages, findings)
  const dependencyEntriesList = dependencyEntries(profileManifest.dependencies, 'dependencies', profileManifestFile, findings)
  for (const [name, range] of dependencyEntriesList) {
    if (looksLikeSemverRange(range) && semver.validRange(range) === null) {
      findings.push(finding('error', 'INVALID_PROFILE_DEPENDENCY_RANGE', `Profile dependency ${name} has an invalid semantic version range.`, {
        package: name,
        evidence: `${profileManifestFile}: ${range}`,
        suggestion: 'Repair the dependency range before installing or starting this profile.',
      }))
    }
  }
  const dependencyNames = dependencyEntriesList.map(([name]) => name)
  const dshConfig = profileManifest.dsh
  const dshConfigValid = dshConfig === undefined || objectRecord(dshConfig) !== undefined
  if (!dshConfigValid) {
    findings.push(finding('error', 'INVALID_DSH_CONFIGURATION', 'dsh must be an object when present.', {
      evidence: profileManifestFile,
      suggestion: 'Repair the dsh configuration object before starting Harness.',
    }))
  }
  const profileConfigValue = objectRecord(dshConfig)?.profile
  const profileConfigValid = profileConfigValue === undefined || objectRecord(profileConfigValue) !== undefined
  if (dshConfigValid && !profileConfigValid) {
    findings.push(finding('error', 'INVALID_PROFILE_CONFIGURATION', 'dsh.profile must be an object when present.', {
      evidence: profileManifestFile,
      suggestion: 'Repair the dsh.profile configuration object before starting Harness.',
    }))
  }
  const profileConfig = objectRecord(profileConfigValue)
  const bundles = profileConfig?.bundles
  if (bundles !== undefined && (!Array.isArray(bundles) || !bundles.every(item => typeof item === 'string'))) {
    findings.push(finding('error', 'INVALID_BUNDLE_LIST', 'dsh.profile.bundles must be a string array.', {
      evidence: profileManifestFile,
      suggestion: 'Repair the profile manifest before starting Harness.',
    }))
  }
  const bundleNames = Array.isArray(bundles) ? [...new Set(bundles.filter(item => typeof item === 'string'))] : []
  const patchReload = profileConfig?.patchReload
  if (patchReload !== undefined && patchReload !== 'live' && patchReload !== 'startup') {
    findings.push(finding('error', 'INVALID_PATCH_RELOAD', 'dsh.profile.patchReload must be "live" or "startup".', {
      evidence: profileManifestFile,
      suggestion: 'Choose the reload lifecycle intended for this profile.',
    }))
  }

  const records = new Map()
  for (const name of dependencyNames) {
    const record = resolvePackage(name)
    if (record !== undefined) records.set(name, record)
  }
  const lockfile = inspectPnpmLock(
    profileDir, dependencyEntriesList, records, findings, commandRepair, profile,
  )
  inspectRuntimeAlignment(harness, dshCli, findings)
  inspectProfileHarnessPackages(profileDir, home, harness, findings)
  const bundleRecords = new Map()
  for (const name of bundleNames) {
    const record = resolveBundle(name)
    if (record !== undefined) bundleRecords.set(name, record)
  }
  for (const name of dependencyNames) {
    const record = records.get(name)
    if (record === undefined) {
      findings.push(finding('error', 'DEPENDENCY_NOT_INSTALLED', `Profile dependency ${name} is not installed.`, {
        package: name,
        evidence: profileManifestFile,
        suggestion: 'Use the exact command shown below to install the declared profile dependencies.',
        repair: commandRepair(
          `install-profile:${profile}`,
          `Install the declared dependencies for profile ${profile}.`,
          ['plugin', '--profile', profile, 'install'],
          { profile },
        ),
      }))
      continue
    }
    const declared = dependencyEntriesList.find(([dependency]) => dependency === name)?.[1]
    const installed = record.manifest?.version
    if (typeof declared === 'string' && typeof installed === 'string'
      && semver.validRange(declared) !== null && semver.valid(installed) !== null
      && !semver.satisfies(installed, declared, { includePrerelease: true })) {
      findings.push(finding('warning', 'PROFILE_DEPENDENCY_VERSION_MISMATCH', `Profile requests ${name} ${declared}, but ${installed} is installed.`, {
        package: name,
        evidence: record.file,
        suggestion: 'Use the exact command shown below to reconcile the profile installation.',
        repair: commandRepair(
          `install-profile:${profile}`,
          `Install the declared dependencies for profile ${profile}.`,
          ['plugin', '--profile', profile, 'install'],
          { profile },
        ),
      }))
    }
    if (dshConfigValid && profileConfigValid
      && record.manifest?.dsh?.bundle?.patch !== undefined && !bundleNames.includes(name)) {
      findings.push(finding('warning', 'INSTALLED_BUNDLE_INACTIVE', `${name} is installed as a bundle but is absent from dsh.profile.bundles.`, {
        package: name,
        evidence: profileManifestFile,
        suggestion: 'Re-run the matching dsh plugin add/update command or remove the unused dependency.',
        repair: {
          id: `activate-bundle:${name}`,
          kind: 'json-edit',
          risk: 'low',
          description: `Add ${name} to dsh.profile.bundles.`,
          file: profileManifestFile,
          operation: { type: 'add-bundle', name },
        },
      }))
    }
  }
  const patchLayers = []
  let patchCompositionValid = true
  for (const name of bundleNames) {
    const layer = inspectBundle(name, bundleRecords.get(name), findings)
    if (layer === undefined) patchCompositionValid = false
    else patchLayers.push(layer)
  }

  for (const [file, subject, label] of [
    [join(profileDir, 'cordis.patch.yml'), 'profile patch', 'profile patch'],
    [join(home, 'cordis.patch.yml'), 'home patch', 'home patch'],
  ]) {
    const patches = inspectPatchFileIfPresent(file, subject, findings)
    if (patches !== undefined) patchLayers.push({ file, label, patches })
    else if (existsSync(file)) patchCompositionValid = false
  }
  if (patchCompositionValid) inspectPatchComposition(patchLayers, findings)
  inspectSettings(join(home, 'settings.yaml'), findings)
  inspectCredentials(join(home, '.credentials.yaml'), findings)

  const thirdPartyRecords = dependencyNames
    .map(name => records.get(name))
    .filter(record => record !== undefined)
  for (const record of thirdPartyRecords) {
    inspectClientPackage(record, {
      findings,
      commandRepair,
      harnessPackages: harness.packages,
      harnessPackagesAuthoritative: harness.authoritative,
      profile,
      resolvePackage,
    })
    inspectCompatibility(record, {
      findings,
      commandRepair,
      profile,
      resolvePackage,
      harnessPackages: harness.packages,
      harnessPackagesAuthoritative: harness.authoritative,
    })
    inspectPluginNodeEngine(
      record,
      dshCli?.command?.[0] === process.execPath ? process.version : undefined,
      findings,
    )
  }

  return finish({
    home,
    profile,
    profileDir,
    harness: { root: harness.root, version: harness.version },
    lockfile,
    dshCli: dshCli === undefined
      ? { available: false, commandRepairNeeded }
      : { available: true, commandRepairNeeded, ...dshCli },
    packages: dependencyNames.map(name => {
      const record = records.get(name)
      if (record === undefined) return { name, installed: false, compatibility: 'incompatible' }
      return {
        name: record.requestedName ?? record.manifest.name,
        version: record.manifest.version,
        directory: record.directory,
        installed: true,
        client: record.manifest?.dsh?.client !== undefined,
        bundle: record.manifest?.dsh?.bundle !== undefined,
        compatibility: pluginCompatibility(record, findings),
      }
    }),
  }, findings)
}

function finish(context, findings) {
  findings.sort((left, right) => {
    const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    return severity || left.code.localeCompare(right.code) || left.message.localeCompare(right.message)
  })
  const summary = {
    errors: findings.filter(item => item.severity === 'error').length,
    warnings: findings.filter(item => item.severity === 'warning').length,
    info: findings.filter(item => item.severity === 'info').length,
  }
  const compatibility = {
    incompatible: context.packages.filter(item => item.compatibility === 'incompatible').length,
    risk: context.packages.filter(item => item.compatibility === 'risk').length,
    unknown: context.packages.filter(item => item.compatibility === 'unknown').length,
    compatible: context.packages.filter(item => item.compatibility === 'compatible').length,
  }
  context = { ...context, compatibility }
  return { version: 1, ok: summary.errors === 0, context, summary, findings }
}

function appendReportField(lines, label, value, indent = '      ') {
  const valueLines = String(value).split('\n')
  if (valueLines.length === 1) {
    lines.push(`${indent}${label}: ${valueLines[0]}`)
    return
  }
  lines.push(`${indent}${label}:`)
  lines.push(...valueLines.map(line => `${indent}  ${line}`))
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))]
}

export function formatReport(report, options = {}) {
  const color = options.color ?? false
  const language = options.language ?? 'en'
  const zh = language === 'zh'
  const paint = (severity, value) => {
    if (!color) return value
    const code = severity === 'error' ? 31 : severity === 'warning' ? 33 : 36
    return `\u001B[${code}m${value}\u001B[0m`
  }
  const quote = value => /^[a-zA-Z0-9_@./:\\-]+$/.test(value) ? value : JSON.stringify(value)
  const cli = report.context.dshCli
  const cliText = cli?.available
    ? `${cli.source}${cli.version ? ` ${cli.version}` : ''} (${cli.command.map(quote).join(' ')})`
    : zh ? '未找到（命令型修复已禁用）' : 'not found (command-based repairs disabled)'
  const lines = [
    'DSH Doctor',
    `${zh ? 'Profile' : 'Profile'}: ${report.context.profile}`,
    `${zh ? 'DSH 主目录' : 'Home'}: ${report.context.home}`,
    `${zh ? '当前使用的 DSH' : 'Active DSH'}: ${report.context.harness.version ?? 'unknown'}${report.context.harness.root ? ` (${report.context.harness.root})` : ''}`,
    `${zh ? 'DSH CLI' : 'DSH CLI'}: ${cliText}`,
    `${zh ? 'Profile 插件' : 'Profile plugins'}: ${String(report.context.packages.length)}`,
    zh
      ? `插件兼容性: ${String(report.context.compatibility.incompatible)} 个不兼容，${String(report.context.compatibility.risk)} 个风险，${String(report.context.compatibility.unknown)} 个未知，${String(report.context.compatibility.compatible)} 个兼容`
      : `Plugin compatibility: ${String(report.context.compatibility.incompatible)} incompatible, ${String(report.context.compatibility.risk)} risk, ${String(report.context.compatibility.unknown)} unknown, ${String(report.context.compatibility.compatible)} compatible`,
    `${zh ? '输出语言' : 'Output language'}: ${languageName(language)}`,
    '',
  ]
  const packageNames = new Set(report.context.packages.map(item => item.name))
  const pluginFindings = new Map()
  const environmentFindings = []
  for (const item of report.findings) {
    if (item.package !== undefined && packageNames.has(item.package)) {
      const items = pluginFindings.get(item.package) ?? []
      items.push(item)
      pluginFindings.set(item.package, items)
    } else environmentFindings.push(item)
  }
  const problemPackages = report.context.packages
    .filter(item => (item.compatibility === 'incompatible' || item.compatibility === 'risk')
      && pluginFindings.has(item.name))
    .sort((left, right) => {
      const rank = { incompatible: 0, risk: 1 }
      return rank[left.compatibility] - rank[right.compatibility] || left.name.localeCompare(right.name)
    })
  const unknownPackages = report.context.packages
    .filter(item => item.compatibility === 'unknown')
    .sort((left, right) => left.name.localeCompare(right.name))

  if (report.findings.length === 0 && unknownPackages.length === 0) {
    lines.push(paint('info', zh ? '正常  当前检查范围内未发现问题。' : 'OK  No problems found by the MVP checks.'))
  } else {
    if (problemPackages.length > 0) {
      lines.push(zh
        ? `插件问题（${String(problemPackages.length)} 个）`
        : `Plugin problems (${String(problemPackages.length)})`)
      lines.push('')
      for (const plugin of problemPackages) {
        const originals = pluginFindings.get(plugin.name)
        const status = plugin.compatibility === 'incompatible'
          ? zh ? '不兼容' : 'INCOMPATIBLE'
          : zh ? '有风险' : 'RISK'
        const severity = plugin.compatibility === 'incompatible' ? 'error' : 'warning'
        lines.push(paint(severity, `[${status}] ${plugin.name}`))
        appendReportField(lines, zh ? '版本' : 'Version', plugin.installed === false
          ? zh ? '未安装' : 'not installed'
          : plugin.version ?? (zh ? '未知' : 'unknown'))
        lines.push(zh
          ? `      问题（${String(originals.length)}）:`
          : `      Problems (${String(originals.length)}):`)
        originals.forEach((original, index) => {
          const item = localizedFinding(original, language)
          const prefix = `${plugin.name} `
          const message = item.message.startsWith(prefix) ? item.message.slice(prefix.length) : item.message
          lines.push(`        ${String(index + 1)}. [${item.code}] ${message}`)
          if (item.evidence !== undefined) appendReportField(
            lines, zh ? '证据' : 'Evidence', item.evidence, '          ',
          )
        })
        const suggestionGroups = new Map()
        for (const original of originals) {
          const suggestion = localizedFinding(original, language).suggestion
          if (suggestion === undefined) continue
          const key = original.repair?.id ?? `suggestion:${suggestion}`
          if (!suggestionGroups.has(key)) suggestionGroups.set(key, suggestion)
        }
        const suggestions = [...suggestionGroups.values()]
        if (suggestions.length > 0) {
          lines.push(`      ${zh ? '处理建议' : 'Recommended actions'}:`)
          suggestions.forEach(item => lines.push(`        - ${item}`))
        }
        const commands = uniqueStrings(originals
          .filter(item => item.repair?.kind === 'command')
          .map(item => item.repair.command.map(quote).join(' ')))
        if (commands.length > 0) {
          lines.push(`      ${zh ? '可执行命令' : 'Available commands'}:`)
          commands.forEach(command => lines.push(`        $ ${command}`))
        }
        lines.push('')
      }
    }

    if (unknownPackages.length > 0) {
      lines.push(zh
        ? `兼容性未确认（${String(unknownPackages.length)} 个插件）`
        : `Compatibility unknown (${String(unknownPackages.length)} plugin(s))`)
      for (const plugin of unknownPackages) {
        lines.push(`[${zh ? '未知' : 'UNKNOWN'}] ${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}`)
        appendReportField(lines, zh ? '原因' : 'Reason', zh
          ? '插件没有声明当前 DSH 的兼容范围。'
          : 'The plugin does not declare a compatibility range for the active DSH.')
        appendReportField(lines, zh ? '建议' : 'Action', zh
          ? '升级 DSH 后请关注该插件的发布说明或向插件作者确认。'
          : 'After a DSH upgrade, review the plugin release notes or ask its author to confirm compatibility.')
      }
      lines.push('')
    }

    const stale = environmentFindings.filter(item => item.code === 'STALE_PROFILE_HARNESS_PACKAGE')
    const otherEnvironment = environmentFindings.filter(item => item.code !== 'STALE_PROFILE_HARNESS_PACKAGE')
    if (stale.length > 0 || otherEnvironment.length > 0) {
      lines.push(zh ? 'DSH 环境问题' : 'DSH environment problems')
      lines.push('')
    }
    if (stale.length > 0) {
      lines.push(paint('warning', zh
        ? `[警告] [STALE_PROFILE_HARNESS_PACKAGE ×${String(stale.length)}] 检测到当前 DSH 已不再包含的 profile 残留包。`
        : `[WARN] [STALE_PROFILE_HARNESS_PACKAGE ×${String(stale.length)}] Profile packages remain that the active DSH no longer includes.`))
      lines.push(`      ${zh ? '残留包' : 'Stale packages'}:`)
      for (const original of stale) {
        const item = localizedFinding(original, language)
        lines.push(`        - ${item.package ?? (zh ? '未知包' : 'unknown package')}`)
        if (item.evidence !== undefined) appendReportField(
          lines, zh ? '位置' : 'Location', item.evidence, '          ',
        )
      }
      const suggestions = uniqueStrings(stale.map(item => localizedFinding(item, language).suggestion))
      suggestions.forEach(item => appendReportField(lines, zh ? '处理建议' : 'Recommended action', item))
      lines.push('')
    }
    for (const original of otherEnvironment) {
      const item = localizedFinding(original, language)
      const label = zh
        ? item.severity === 'error' ? '错误' : item.severity === 'warning' ? '警告' : '信息'
        : item.severity === 'error' ? 'ERROR' : item.severity === 'warning' ? 'WARN' : 'INFO'
      lines.push(paint(item.severity, `${label} [${item.code}] ${item.message}`))
      if (item.package !== undefined) appendReportField(lines, zh ? '包' : 'Package', item.package)
      if (item.evidence !== undefined) appendReportField(lines, zh ? '证据' : 'Evidence', item.evidence)
      if (item.suggestion !== undefined) appendReportField(lines, zh ? '处理建议' : 'Recommended action', item.suggestion)
      if (item.repair?.kind === 'command') appendReportField(
        lines, zh ? '可执行命令' : 'Available command', `$ ${item.repair.command.map(quote).join(' ')}`,
      )
      lines.push('')
    }
  }
  lines.push(zh
    ? `汇总：${String(report.summary.errors)} 个错误，${String(report.summary.warnings)} 个警告`
    : `Summary: ${String(report.summary.errors)} error(s), ${String(report.summary.warnings)} warning(s)`)
  if (report.summary.errors > 0) lines.push(zh
    ? 'DSH 可能无法启动。请优先更新或停用产生错误的插件。'
    : 'DSH may fail to start. Upgrade or disable the error-producing plugin first.')
  lines.push('')
  lines.push(zh
    ? '本诊断结果由 @bruc3van/dsh-doctor 生成，仅供参考。欢迎在 GitHub Star 或反馈问题：https://github.com/bruc3van/dsh-doctor'
    : 'This diagnostic report was generated by @bruc3van/dsh-doctor for reference only. Star the project or share feedback on GitHub: https://github.com/bruc3van/dsh-doctor')
  return `${lines.join('\n')}\n`
}
