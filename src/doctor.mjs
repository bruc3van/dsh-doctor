import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 }

function finding(severity, code, message, options = {}) {
  return {
    severity,
    code,
    message,
    ...options.package === undefined ? {} : { package: options.package },
    ...options.evidence === undefined ? {} : { evidence: options.evidence },
    ...options.suggestion === undefined ? {} : { suggestion: options.suggestion },
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
    return JSON.parse(text)
  } catch (error) {
    findings.push(finding('error', 'INVALID_JSON', `${subject} is not valid JSON.`, {
      evidence: `${file}: ${error instanceof Error ? error.message : String(error)}`,
      suggestion: 'Repair the JSON before starting this profile.',
    }))
    return undefined
  }
}

function packagePathParts(name) {
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
  return { directory, file, manifest }
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
    const manifest = readJson(file, 'Harness workspace package manifest', findings)
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
      return { root, packages: new Map(), version: undefined, authoritative: true }
    }
    const manifest = readJson(join(root, 'package.json'), 'Harness root manifest', findings)
    return { root, packages: indexWorkspace(root, findings), version: manifest?.version, authoritative: true }
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
    cache.set(name, workspace)
    return workspace
  }
}

function clientExport(manifest) {
  const value = manifest?.exports?.['./client']
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    if (typeof value.default === 'string') return value.default
    if (typeof value.browser === 'string') return value.browser
  }
  return undefined
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
  const pattern = /\brequire\s*\(\s*(['"])([^'"\\\r\n]+)\1\s*\)/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2]
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
    if (packagePathParts(specifier) !== undefined || specifier.startsWith('@')) values.add(specifier)
  }
  return [...values].sort()
}

function stripClientSuffix(specifier) {
  return specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier
}

function stringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined
}

function inspectClientPackage(record, context) {
  const {
    findings, harnessPackages, harnessPackagesAuthoritative, profile, resolvePackage,
  } = context
  const name = record.manifest.name
  const disableSuggestion = `Upgrade ${name}; if no compatible release exists, run dsh plugin --profile ${profile} remove ${name}.`
  const declaration = record.manifest?.dsh?.client
  if (declaration === undefined) return
  if (declaration === null || typeof declaration !== 'object') {
    findings.push(finding('error', 'INVALID_CLIENT_DECLARATION', `${name} has an invalid dsh.client declaration.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
    }))
    return
  }

  const external = stringArray(declaration.external)
  const inject = stringArray(declaration.inject)
  if (declaration.external !== undefined && external === undefined) {
    findings.push(finding('error', 'INVALID_CLIENT_EXTERNAL', `${name} dsh.client.external must be a string array.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
    }))
  }
  if (declaration.inject !== undefined && inject === undefined) {
    findings.push(finding('error', 'INVALID_CLIENT_INJECT', `${name} dsh.client.inject must be a string array.`, {
      package: name,
      evidence: record.file,
      suggestion: disableSuggestion,
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
  if (file === undefined || !existsSync(file) || !statSync(file).isFile()) {
    findings.push(finding('error', 'CLIENT_BUNDLE_MISSING', `${name} client bundle is missing.`, {
      package: name,
      evidence: file ?? `${record.file}: exports["./client"] = ${JSON.stringify(exported)}`,
      suggestion: `Reinstall or rebuild ${name}; if it remains broken, run dsh plugin --profile ${profile} remove ${name}.`,
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
      suggestion: `Run dsh plugin --profile <profile> install, upgrade the bundle, or remove it from the profile.`,
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
  if (file === undefined || !existsSync(file)) {
    findings.push(finding('error', 'BUNDLE_PATCH_MISSING', `${name} bundle patch is missing.`, {
      package: name,
      evidence: file ?? `${record.file}: dsh.bundle.patch = ${JSON.stringify(patch)}`,
      suggestion: 'Reinstall or upgrade this bundle, or remove it from the profile.',
    }))
  }
}

export function defaultDshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) {
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
      suggestion: `Start the profile once or initialize it with dsh plugin --profile ${profile} install.`,
    }))
    return finish({ home, profile, profileDir, harness: {}, packages: [] }, findings)
  }
  const profileManifest = readJson(profileManifestFile, `profile ${profile} manifest`, findings)
  if (profileManifest === undefined) {
    return finish({ home, profile, profileDir, harness: {}, packages: [] }, findings)
  }

  const harness = resolveHarnessContext(home, options.harnessRoot, findings)
  const resolvePackage = packageResolver(profileDir, home, harness.packages, findings)
  const dependencyNames = Object.keys(profileManifest.dependencies ?? {})
  const bundles = profileManifest?.dsh?.profile?.bundles
  if (bundles !== undefined && (!Array.isArray(bundles) || !bundles.every(item => typeof item === 'string'))) {
    findings.push(finding('error', 'INVALID_BUNDLE_LIST', 'dsh.profile.bundles must be a string array.', {
      evidence: profileManifestFile,
      suggestion: 'Repair the profile manifest before starting Harness.',
    }))
  }
  const bundleNames = Array.isArray(bundles) ? bundles.filter(item => typeof item === 'string') : []

  const records = new Map()
  for (const name of new Set([...dependencyNames, ...bundleNames])) {
    const record = resolvePackage(name)
    if (record !== undefined) records.set(name, record)
  }
  for (const name of dependencyNames) {
    const record = records.get(name)
    if (record === undefined) {
      findings.push(finding('error', 'DEPENDENCY_NOT_INSTALLED', `Profile dependency ${name} is not installed.`, {
        package: name,
        evidence: profileManifestFile,
        suggestion: `Run dsh plugin --profile ${profile} install.`,
      }))
      continue
    }
    if (record.manifest?.dsh?.bundle?.patch !== undefined && !bundleNames.includes(name)) {
      findings.push(finding('warning', 'INSTALLED_BUNDLE_INACTIVE', `${name} is installed as a bundle but is absent from dsh.profile.bundles.`, {
        package: name,
        evidence: profileManifestFile,
        suggestion: 'Re-run the matching dsh plugin add/update command or remove the unused dependency.',
      }))
    }
  }
  for (const name of bundleNames) inspectBundle(name, records.get(name), findings)

  const thirdPartyRecords = dependencyNames
    .map(name => records.get(name))
    .filter(record => record !== undefined)
  for (const record of thirdPartyRecords) {
    inspectClientPackage(record, {
      findings,
      harnessPackages: harness.packages,
      harnessPackagesAuthoritative: harness.authoritative,
      profile,
      resolvePackage,
    })
  }

  return finish({
    home,
    profile,
    profileDir,
    harness: { root: harness.root, version: harness.version },
    packages: thirdPartyRecords.map(record => ({
      name: record.manifest.name,
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
  return { version: 1, context, summary, findings }
}

export function formatReport(report, options = {}) {
  const color = options.color ?? false
  const paint = (severity, value) => {
    if (!color) return value
    const code = severity === 'error' ? 31 : severity === 'warning' ? 33 : 36
    return `\u001B[${code}m${value}\u001B[0m`
  }
  const lines = [
    'DSH Doctor',
    `Profile: ${report.context.profile}`,
    `Home: ${report.context.home}`,
    `Harness: ${report.context.harness.version ?? 'unknown'}${report.context.harness.root ? ` (${report.context.harness.root})` : ''}`,
    `Checked third-party packages: ${String(report.context.packages.length)}`,
    '',
  ]
  if (report.findings.length === 0) {
    lines.push(paint('info', 'OK  No problems found by the MVP checks.'))
  } else {
    for (const item of report.findings) {
      const label = item.severity === 'error' ? 'ERROR' : item.severity === 'warning' ? 'WARN ' : 'INFO '
      lines.push(paint(item.severity, `${label} [${item.code}] ${item.message}`))
      if (item.package !== undefined) lines.push(`      Package: ${item.package}`)
      if (item.evidence !== undefined) lines.push(`      Evidence: ${item.evidence}`)
      if (item.suggestion !== undefined) lines.push(`      Action: ${item.suggestion}`)
      lines.push('')
    }
  }
  lines.push(`Summary: ${String(report.summary.errors)} error(s), ${String(report.summary.warnings)} warning(s)`)
  if (report.summary.errors > 0) lines.push('Harness may fail to start. Upgrade or disable the error-producing plugin first.')
  return `${lines.join('\n')}\n`
}
