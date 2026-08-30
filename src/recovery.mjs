import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isSeq, parseDocument } from 'yaml'
import yaml from 'js-yaml'
import semver from 'semver'
import { atomicWrite, snapshotFile } from './safe-write.mjs'
import { redactSecrets } from './redact.mjs'

const CAUSES = new Map([
  ['HARNESS_PEER_VERSION_MISMATCH', 'plugin-version'],
  ['PROFILE_DEPENDENCY_VERSION_MISMATCH', 'plugin-version'],
  ['LEGACY_HARNESS_PEERS', 'plugin-version'],
  ['LEGACY_HARNESS_DEPENDENCIES', 'plugin-version'],
  ['BUNDLE_PATCH_MISSING', 'plugin-artifact'],
  ['BUNDLE_NOT_INSTALLED', 'plugin-artifact'],
  ['BUNDLE_DECLARATION_MISSING', 'plugin-artifact'],
  ['CLIENT_BUNDLE_MISSING', 'plugin-artifact'],
  ['CLIENT_BUNDLE_UNREADABLE', 'plugin-artifact'],
  ['CLIENT_EXPORT_MISSING', 'client-contract'],
  ['INVALID_CLIENT_DECLARATION', 'client-contract'],
  ['INVALID_CLIENT_PLATFORM', 'client-contract'],
  ['INVALID_CLIENT_IMMEDIATELY', 'client-contract'],
  ['INVALID_CLIENT_EXTERNAL', 'client-contract'],
  ['INVALID_CLIENT_INJECT', 'client-contract'],
  ['CLIENT_EXTERNAL_WITHOUT_SUPPLIER', 'client-contract'],
  ['UNDECLARED_CLIENT_REQUIRE', 'client-contract'],
  ['REDUNDANT_CLIENT_EXTERNAL', 'client-contract'],
  ['REMOVED_CLIENT_INJECT', 'client-contract'],
  ['INVALID_HARNESS_PEER_RANGE', 'plugin-version'],
  ['INVALID_DEPENDENCY_MAP', 'missing-dependency'],
  ['PATCH_TARGET_NOT_FOUND', 'patch-version'],
  ['PATCH_INCOMPATIBLE_WITH_CURRENT_DSH', 'patch-version'],
  ['CORE_ENTRY_DISABLED_BY_HIGHER_LAYER', 'config-override'],
  ['CONFIG_REPLACED_BY_HIGHER_LAYER', 'config-override'],
  ['GROUP_CONTENT_REPLACED', 'config-override'],
  ['BUNDLE_PROFILE_DECLARATION_CONFLICT', 'config-override'],
  ['DUPLICATE_ENTRY_ID', 'duplicate-mount'],
  ['DUPLICATE_PLUGIN_MOUNT', 'duplicate-mount'],
  ['DEPENDENCY_NOT_INSTALLED', 'missing-dependency'],
  ['PLUGIN_NODE_VERSION_MISMATCH', 'runtime-environment'],
])

function causeFor(findings) {
  const ordered = findings.filter(item => CAUSES.has(item.code))
  const primary = ordered.find(item => item.severity === 'error') ?? ordered[0]
  if (primary === undefined) return { type: 'unknown', confidence: 'unknown', summary: 'No confirmed root cause was identified.' }
  return {
    type: CAUSES.get(primary.code),
    confidence: primary.severity === 'error' || primary.code === 'HARNESS_PEER_VERSION_MISMATCH' ? 'confirmed' : 'likely',
    summary: primary.message,
    findingCodes: [...new Set(ordered.map(item => item.code))],
  }
}

function entriesFor(configuration, packageName) {
  return configuration.entries.filter(entry => entry.name === packageName || entry.origin?.package === packageName)
}

function activeEntriesFor(configuration, packageName) {
  return entriesFor(configuration, packageName).filter(entry => entry.disabled !== true)
}

function quarantineOption(configuration, packageInfo, packages) {
  const packageName = packageInfo.name
  const entries = activeEntriesFor(configuration, packageName)
  const ids = entries.map(entry => entry.id)
  const duplicateIds = configuration.issues.filter(issue => issue.code === 'DUPLICATE_ENTRY_ID').map(issue => issue.details.id)
  const blockers = []
  if (packageName === '@deepseek-ai/dsh-base' || packageName.startsWith('@deepseek-ai/dsh-base-')) {
    blockers.push('package is a template or in-box core bundle')
  }
  if (entries.length === 0) blockers.push('no active entry can be mapped to this package')
  if (ids.some(id => typeof id !== 'string' || id.length === 0)) blockers.push('one or more active entries have no stable id')
  if (ids.some(id => duplicateIds.includes(id))) blockers.push('a target entry id is duplicated')
  const ownedLayers = configuration.layerDetails?.filter(layer => layer.package === packageName) ?? []
  if (ownedLayers.some(layer => layer.overrideCount > 0)) blockers.push('the bundle modifies entries owned by another layer')
  const clientDependents = packages.filter(candidate => candidate.name !== packageName
    && [...candidate.clientExternal ?? [], ...candidate.clientInject ?? []]
      .some(specifier => specifier === packageName || specifier.startsWith(`${packageName}/`)))
    .map(candidate => candidate.name)
  if (clientDependents.length > 0) blockers.push('other plugins declare client dependencies on this package')
  if (packageInfo.runtimeServiceProvider?.status === 'detected') {
    blockers.push('the plugin appears to provide runtime Services whose dependents cannot be proven statically')
  }
  const problematic = packageInfo.compatibility === 'incompatible' || packageInfo.compatibility === 'risk'
  return {
    kind: 'quarantine',
    availability: blockers.length === 0 ? 'available' : 'requires-review',
    risk: 'low',
    recommended: blockers.length === 0 && problematic,
    reason: blockers.length === 0
      ? 'All active entries owned by the plugin can be disabled with name assertions.'
      : 'Safe isolation cannot be proven automatically.',
    impact: {
      entryIds: ids.filter(id => typeof id === 'string'),
      entries: entries.filter(entry => typeof entry.id === 'string').map(entry => ({
        id: entry.id,
        name: entry.name,
        disabledSource: entry.fields?.disabled?.source,
      })),
      clientDependents,
      serviceDependents: {
        status: 'unknown',
        provider: packageInfo.runtimeServiceProvider ?? { status: 'not-checked' },
      },
      blockers,
    },
  }
}

function removalOption(configuration, packageInfo, packages, bundleNames, profileManifest, lockfile, quarantine, dshCli) {
  const packageName = packageInfo.name
  const directDependency = Object.hasOwn(profileManifest.dependencies ?? {}, packageName)
  const bundleLayer = bundleNames.includes(packageName)
  const entries = entriesFor(configuration, packageName)
  const manualMounts = entries.filter(entry => ['profile', 'home', 'overlay'].includes(entry.origin?.kind))
    .map(entry => ({ id: entry.id, file: entry.origin.file, patchIndex: entry.origin.patchIndex }))
  const patchReferences = configuration.patchReferences?.filter(reference => entries.some(entry => entry.id === reference.id)
    && reference.package !== packageName) ?? []
  const core = packageName.startsWith('@deepseek-ai/dsh-base') || (!directDependency && bundleLayer)
  const clientDependents = packages.filter(candidate => candidate.name !== packageName
    && [...candidate.clientExternal ?? [], ...candidate.clientInject ?? []]
      .some(specifier => specifier === packageName || specifier.startsWith(`${packageName}/`)))
    .map(candidate => candidate.name)
  const blockers = []
  if (!directDependency) blockers.push('package is not a direct profile dependency')
  if (core) blockers.push('package is a template or in-box core bundle')
  if (lockfile?.present !== true || lockfile.valid !== true) blockers.push('profile lockfile is missing or unreadable')
  if (!dshCli?.available) blockers.push('no working DSH CLI is available')
  if (manualMounts.length > 0) blockers.push('manual mounts would remain after package removal')
  if (patchReferences.length > 0) blockers.push('higher-layer patches would become dangling references')
  if (clientDependents.length > 0) blockers.push('other plugins declare client dependencies on this package')
  if (quarantine.availability !== 'available') blockers.push('a complete temporary quarantine cannot be generated')
  return {
    kind: 'remove',
    availability: blockers.length === 0 ? 'available' : 'unavailable',
    risk: 'medium',
    recommended: false,
    reason: blockers.length === 0 ? 'Static removal preflight passed; dynamic Service dependencies remain unknown.' : 'Removal preflight found blockers.',
    impact: {
      package: packageName,
      directDependency,
      bundleLayer,
      hostEntries: entries.map(entry => entry.id).filter(Boolean),
      clientBundle: packageInfo.client === true,
      manualMounts,
      patchReferences,
      clientDependents,
      serviceDependents: { status: 'unknown' },
      blockers,
      rollback: packageInfo.version === undefined ? undefined : {
        command: ['plugin', '--profile', configuration.profile, 'add', `${packageName}@${packageInfo.version}`],
      },
    },
  }
}

export function buildPluginDiagnoses({ packages, findings, configuration, bundleNames, profileManifest, lockfile, dshCli }) {
  return packages.map(packageInfo => {
    const related = findings.filter(item => item.package === packageInfo.name)
    const entries = configuration.entries.filter(entry => entry.name === packageInfo.name || entry.origin?.package === packageInfo.name)
    const quarantine = quarantineOption(configuration, packageInfo, packages)
    const remove = removalOption(configuration, packageInfo, packages, bundleNames, profileManifest, lockfile, quarantine, dshCli)
    const options = [
      { kind: 'update', availability: 'unknown', risk: 'medium', recommended: false, reason: 'Registry compatibility has not been checked.', impact: {} },
      ...related.some(item => ['PATCH_TARGET_NOT_FOUND', 'PATCH_INCOMPATIBLE_WITH_CURRENT_DSH'].includes(item.code))
        ? [{ kind: 'adjust-patch', availability: 'requires-review', risk: 'medium', recommended: true, reason: 'A configuration layer targets an entry from an older DSH tree.', impact: {} }]
        : [],
      ...related.some(item => ['CORE_ENTRY_DISABLED_BY_HIGHER_LAYER', 'CONFIG_REPLACED_BY_HIGHER_LAYER', 'GROUP_CONTENT_REPLACED'].includes(item.code))
        ? [{ kind: 'rollback-override', availability: 'requires-review', risk: 'medium', recommended: true, reason: 'A higher configuration layer overrides this plugin or its target.', impact: {} }]
        : [],
      quarantine,
      remove,
    ]
    const recommended = options.find(option => option.recommended)?.kind ?? 'keep'
    return {
      name: packageInfo.name,
      installedVersion: packageInfo.version,
      status: packageInfo.compatibility,
      cause: causeFor(related),
      configuration: {
        originLayer: entries[0]?.origin?.kind ?? 'unknown',
        entries: entries.map(entry => entry.id).filter(Boolean),
        overriddenBy: [...new Set(entries.flatMap(entry => Object.values(entry.fields ?? {}).map(field => field.source?.kind)).filter(kind => kind !== entries[0]?.origin?.kind))],
        issues: related.filter(item => CAUSES.get(item.code) === 'config-override' || CAUSES.get(item.code) === 'duplicate-mount').map(item => item.code),
      },
      update: { status: 'not-checked' },
      recovery: { recommended, options },
    }
  })
}

export function attachUpdateResult(diagnosis, result, dshCli) {
  diagnosis.update = result
  const update = diagnosis.recovery.options.find(option => option.kind === 'update')
  const isNewer = result.status === 'compatible-candidate-found'
    && (semver.valid(diagnosis.installedVersion) === null || semver.gt(result.version, diagnosis.installedVersion))
  if (result.status === 'compatible-candidate-found' && isNewer) {
    Object.assign(update, {
      availability: 'available',
      recommended: diagnosis.status !== 'compatible',
      reason: `Version ${result.version} declares compatibility with the active DSH packages.`,
      command: dshCli?.available ? [...dshCli.command, 'plugin', '--profile', dshCli.profile, 'add', result.spec] : [],
      impact: { candidateVersion: result.version, validation: 'manifest-declared-only' },
    })
    if (diagnosis.status !== 'compatible') diagnosis.recovery.recommended = 'update'
  } else {
    update.availability = result.status === 'registry-unavailable' ? 'unknown' : 'unavailable'
    update.recommended = false
    update.reason = result.status === 'compatible-candidate-found'
      ? `The highest manifest-compatible version (${result.version}) is not newer than the installed version.`
      : result.status
  }
  return diagnosis
}

export function verifyUpdate(report, packageName, candidateVersion) {
  const diagnosis = report.context.pluginDiagnoses?.find(item => item.name === packageName)
  const installedVersionMatches = diagnosis?.installedVersion === candidateVersion
  const compatibilityPassed = diagnosis !== undefined && !['incompatible', 'risk'].includes(diagnosis.status)
  return {
    package: packageName,
    candidateVersion,
    installedVersion: diagnosis?.installedVersion,
    status: diagnosis?.status ?? 'missing',
    installedVersionMatches,
    compatibilityPassed,
    verified: installedVersionMatches && compatibilityPassed && report.summary.errors === 0,
  }
}

export function quarantineDocument(diagnosis) {
  const option = diagnosis.recovery.options.find(item => item.kind === 'quarantine')
  if (option?.availability !== 'available') throw new Error(`quarantine requires review: ${option?.impact?.blockers?.join('; ') ?? 'unknown plugin mapping'}`)
  return option.impact.entries.map(entry => ({ id: entry.id, name: entry.name, disabled: true }))
}

export function verifyQuarantine(report, patches) {
  const entries = report.context.configuration?.entries ?? []
  const targets = patches.map(patch => {
    const matches = entries.filter(entry => entry.id === patch.id && entry.name === patch.name)
    return {
      id: patch.id,
      name: patch.name,
      matches: matches.length,
      disabled: matches.length === 1 && matches[0].disabled === true,
    }
  })
  return {
    allTargetEntriesDisabled: targets.length > 0 && targets.every(target => target.disabled),
    targets,
  }
}

export function writeQuarantineOverlay(diagnosis, output) {
  const file = resolve(output)
  const document = `${yaml.dump(quarantineDocument(diagnosis), { noRefs: true, lineWidth: 120 })}`
  const snapshot = snapshotFile(file)
  const write = atomicWrite(snapshot, document, { backup: snapshot.exists })
  return { ...write, action: 'quarantine', yaml: document }
}

export function persistentQuarantinePlan(diagnosis, profileDir) {
  const quarantine = diagnosis.recovery.options.find(item => item.kind === 'quarantine')
  const higherLayers = [...new Set((quarantine?.impact?.entries ?? [])
    .map(entry => entry.disabledSource?.kind)
    .filter(kind => kind === 'home' || kind === 'overlay'))]
  if (higherLayers.length > 0) {
    throw new Error(`profile quarantine cannot override higher layer(s): ${higherLayers.join(', ')}`)
  }
  const patches = quarantineDocument(diagnosis)
  const file = join(profileDir, 'cordis.patch.yml')
  const snapshot = snapshotFile(file)
  const document = parseDocument(snapshot.text === '' ? '[]\n' : snapshot.text, {
    prettyErrors: true,
    uniqueKeys: true,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value, stringify: item => `!!js ${JSON.stringify(item.value)}` }],
  })
  if (document.errors.length > 0 || !isSeq(document.contents)) throw new Error(`${file} is not a valid patch list`)
  const current = document.toJS() ?? []
  if (!Array.isArray(current)) throw new Error(`${file} is not a patch list`)
  for (const patch of patches) {
    // Append the final override. Editing an earlier occurrence is not enough:
    // a later `disabled: false` would still win under Harness patch ordering.
    document.contents.add(patch)
  }
  const nextText = document.toString({ lineWidth: 120 })
  return { file, snapshot, before: snapshot.text, after: nextText, diff: exactDiff(snapshot.text, nextText), patches }
}

function exactDiff(before, after) {
  if (before === after) return ''
  const left = before.replace(/\n$/, '').split('\n')
  const right = after.replace(/\n$/, '').split('\n')
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1
  return [
    `@@ line ${String(prefix + 1)} @@`,
    ...left.slice(prefix, left.length - suffix).map(line => `- ${line}`),
    ...right.slice(prefix, right.length - suffix).map(line => `+ ${line}`),
  ].join('\n')
}

export function applyPersistentQuarantine(plan) {
  return { action: 'persist-quarantine', ...atomicWrite(plan.snapshot, plan.after, { recordCreation: true }), patches: plan.patches }
}

export function removalPlan(diagnosis, dshCli, home, profile) {
  const option = diagnosis.recovery.options.find(item => item.kind === 'remove')
  if (option?.availability !== 'available') throw new Error(`remove is unavailable: ${option?.impact?.blockers?.join('; ') ?? 'preflight failed'}`)
  if (!dshCli?.available) throw new Error('no working DSH CLI is available for removal')
  return {
    id: `remove-package:${diagnosis.name}`,
    kind: 'command',
    risk: 'medium',
    description: `Remove ${diagnosis.name} from profile ${profile}.`,
    command: [...dshCli.command, 'plugin', '--profile', profile, 'remove', diagnosis.name],
    env: { DSH_HOME: home },
    impact: option.impact,
  }
}

export function prepareRemovalArtifacts(diagnosis, report) {
  const safeName = diagnosis.name.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const directory = join(report.context.profileDir, '.dsh-doctor', 'recovery', `${stamp}-${safeName}`)
  const snapshotFileName = join(directory, 'diagnosis.json')
  const snapshot = snapshotFile(snapshotFileName)
  atomicWrite(snapshot, `${JSON.stringify(redactSecrets(report), null, 2)}\n`, { backup: false })
  const overlay = writeQuarantineOverlay(diagnosis, join(directory, 'quarantine.yml'))
  return { directory, diagnosis: snapshotFileName, quarantine: overlay.file }
}

export function restoreBackup(backup, target) {
  const resolvedBackup = resolve(backup)
  const resolvedTarget = resolve(target)
  if (resolvedBackup.startsWith(`${resolvedTarget}.dsh-doctor-`) && resolvedBackup.endsWith('.rollback.json')) {
    const record = JSON.parse(readFileSync(resolvedBackup, 'utf8'))
    if (record?.version !== 1 || record.action !== 'delete-created-file' || resolve(record.target) !== resolvedTarget) {
      throw new Error(`invalid rollback record: ${resolvedBackup}`)
    }
    if (!existsSync(resolvedTarget)) return { file: resolvedTarget, status: 'already-absent', rollbackRecord: resolvedBackup }
    const snapshot = snapshotFile(resolvedTarget)
    if (snapshot.hash !== record.expectedHash) throw new Error(`${resolvedTarget} changed after it was created; diagnose again before rollback`)
    unlinkSync(resolvedTarget)
    return { file: resolvedTarget, status: 'deleted', rollbackRecord: resolvedBackup }
  }
  if (!resolvedBackup.startsWith(`${resolvedTarget}.dsh-doctor-`) || !resolvedBackup.endsWith('.bak')) {
    throw new Error(`backup does not belong to target: ${resolvedBackup}`)
  }
  if (!existsSync(resolvedBackup)) throw new Error(`backup does not exist: ${resolvedBackup}`)
  const backupText = readFileSync(resolvedBackup, 'utf8')
  const snapshot = snapshotFile(target)
  return atomicWrite(snapshot, backupText)
}
