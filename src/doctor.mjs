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
  resolve: value => typeof value === 'string' && value.trim().length > 0,
  construct: value => value,
})
const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPRESSION])

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

  findings.push(finding('warning', 'HARNESS_INSTALLATION_UNKNOWN', 'Could not locate the Harness installation used by this home.', {
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

function dependencyEntries(value, field, file, findings) {
  if (value === undefined) return []
  const record = objectRecord(value)
  if (record === undefined || Object.values(record).some(item => typeof item !== 'string')) {
    findings.push(finding('error', 'INVALID_DEPENDENCY_MAP', `${field} must be an object of package names to string ranges.`, {
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
      findings.push(finding('error', 'CLIENT_EXTERNAL_WITHOUT_SUPPLIER', `${name} requests ${specifier}, but the active Harness has no client module supplier.`, {
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
        findings.push(finding('error', 'REMOVED_CLIENT_INJECT', `${name} injects ${dependency}, which is absent from the active Harness source tree.`, {
          package: name,
          evidence: record.file,
          suggestion: disableSuggestion,
          repair: updateRepair(profile, name, commandRepair),
        }))
      }
    }

    const legacyPeers = Object.keys(record.manifest.peerDependencies ?? {})
      .filter(peer => peer.startsWith('@deepseek-ai/dsh-') && !harnessPackages.has(peer))
      .sort()
    if (legacyPeers.length > 0) {
      findings.push(finding('warning', 'LEGACY_HARNESS_PEERS', `${name} still declares Harness packages that no longer exist in the active source tree.`, {
        package: name,
        evidence: legacyPeers.join(', '),
        suggestion: 'Treat this plugin as compatibility-risky and update it before the next Harness upgrade.',
      }))
    }
  }
}

function inspectBundle(name, record, findings) {
  if (record === undefined) {
    findings.push(finding('error', 'BUNDLE_NOT_INSTALLED', `Profile bundle ${name} is not installed.`, {
      package: name,
      suggestion: 'Install the profile dependencies with the active DSH installation, upgrade the bundle, or remove it from the profile.',
    }))
    return
  }
  const patch = record.manifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.length === 0) {
    findings.push(finding('error', 'BUNDLE_DECLARATION_MISSING', `${name} is listed as a profile bundle but declares no dsh.bundle.patch.`, {
      package: name,
      evidence: record.file,
      suggestion: 'Upgrade or remove this bundle from dsh.profile.bundles.',
    }))
    return
  }
  const file = safePackageFile(record.directory, patch)
  if (file === undefined || !regularFile(file)) {
    findings.push(finding('error', 'BUNDLE_PATCH_MISSING', `${name} bundle patch is missing.`, {
      package: name,
      evidence: file ?? `${record.file}: dsh.bundle.patch = ${JSON.stringify(patch)}`,
      suggestion: 'Reinstall or upgrade this bundle, or remove it from the profile.',
    }))
  } else inspectPatchFile(file, `${name} bundle patch`, findings)
}

function inspectPatchFile(file, subject, findings) {
  let parsed
  try {
    parsed = yaml.load(readFileSync(file, 'utf8'), { schema: PATCH_SCHEMA })
  } catch (error) {
    findings.push(finding('error', 'INVALID_PATCH_YAML', `${subject} cannot be parsed.`, {
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'Repair the YAML syntax before starting this profile.',
    }))
    return
  }
  if (!Array.isArray(parsed) || parsed.some(item => objectRecord(item) === undefined)) {
    findings.push(finding('error', 'INVALID_PATCH_LIST', `${subject} must be a top-level YAML array of mappings.`, {
      evidence: file,
      suggestion: 'Repair the patch structure before starting this profile.',
    }))
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
  if (existsSync(file)) inspectPatchFile(file, subject, findings)
}

function inspectCompatibility(record, context) {
  const { commandRepair, findings, harnessPackages, profile, resolvePackage } = context
  const peers = dependencyEntries(record.manifest.peerDependencies, 'peerDependencies', record.file, findings)
  const mismatches = []
  for (const [name, range] of peers) {
    if (!name.startsWith('@deepseek-ai/') && name !== 'cordis') continue
    const supplier = harnessPackages.get(name) ?? resolvePackage(name)
    if (supplier === undefined) continue
    const version = supplier.manifest?.version
    if (typeof version !== 'string' || semver.valid(version) === null || semver.validRange(range) === null) continue
    if (semver.satisfies(version, range, { includePrerelease: true })) continue
    mismatches.push(`${name} ${range} (active ${version})`)
  }
  if (mismatches.length > 0) {
    const name = record.requestedName ?? record.manifest.name
    findings.push(finding('warning', 'HARNESS_PEER_VERSION_MISMATCH', `${name} has Harness peer ranges that do not accept the active versions.`, {
      package: name,
      evidence: mismatches.join(', '),
      suggestion: `Update ${name} to a release compatible with the active Harness.`,
      repair: updateRepair(profile, name, commandRepair),
    }))
  }
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
  for (const name of bundleNames) inspectBundle(name, bundleRecords.get(name), findings)

  inspectPatchFileIfPresent(join(profileDir, 'cordis.patch.yml'), 'profile patch', findings)
  inspectPatchFileIfPresent(join(home, 'cordis.patch.yml'), 'home patch', findings)
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
    })
  }

  return finish({
    home,
    profile,
    profileDir,
    harness: { root: harness.root, version: harness.version },
    dshCli: dshCli === undefined
      ? { available: false, commandRepairNeeded }
      : { available: true, commandRepairNeeded, ...dshCli },
    packages: thirdPartyRecords.map(record => ({
      name: record.requestedName ?? record.manifest.name,
      version: record.manifest.version,
      directory: record.directory,
      client: record.manifest?.dsh?.client !== undefined,
      bundle: record.manifest?.dsh?.bundle !== undefined,
    })),
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
  return { version: 1, ok: summary.errors === 0, context, summary, findings }
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
    `Harness: ${report.context.harness.version ?? 'unknown'}${report.context.harness.root ? ` (${report.context.harness.root})` : ''}`,
    `${zh ? 'DSH CLI' : 'DSH CLI'}: ${cliText}`,
    `${zh ? '已检查第三方包' : 'Checked third-party packages'}: ${String(report.context.packages.length)}`,
    `${zh ? '输出语言' : 'Output language'}: ${languageName(language)}`,
    '',
  ]
  if (report.findings.length === 0) {
    lines.push(paint('info', zh ? '正常  当前检查范围内未发现问题。' : 'OK  No problems found by the MVP checks.'))
  } else {
    for (const original of report.findings) {
      const item = localizedFinding(original, language)
      const label = zh
        ? item.severity === 'error' ? '错误' : item.severity === 'warning' ? '警告' : '信息'
        : item.severity === 'error' ? 'ERROR' : item.severity === 'warning' ? 'WARN ' : 'INFO '
      lines.push(paint(item.severity, `${label} [${item.code}] ${item.message}`))
      if (item.package !== undefined) lines.push(`      ${zh ? '包' : 'Package'}: ${item.package}`)
      if (item.evidence !== undefined) lines.push(`      ${zh ? '证据' : 'Evidence'}: ${item.evidence}`)
      if (item.suggestion !== undefined) lines.push(`      ${zh ? '建议' : 'Action'}: ${item.suggestion}`)
      if (item.repair?.kind === 'command') lines.push(`      ${zh ? '更新命令' : 'Update command'}: ${item.repair.command.map(quote).join(' ')}`)
      lines.push('')
    }
  }
  lines.push(zh
    ? `汇总：${String(report.summary.errors)} 个错误，${String(report.summary.warnings)} 个警告`
    : `Summary: ${String(report.summary.errors)} error(s), ${String(report.summary.warnings)} warning(s)`)
  if (report.summary.errors > 0) lines.push(zh
    ? 'Harness 可能无法启动。请优先更新或停用产生错误的插件。'
    : 'Harness may fail to start. Upgrade or disable the error-producing plugin first.')
  return `${lines.join('\n')}\n`
}
