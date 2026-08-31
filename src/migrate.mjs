import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import semver from 'semver'
import ts from 'typescript'
import { parseDocument } from 'yaml'
import { atomicWrite, sha256, sha256File, writeNewFile } from './safe-write.mjs'
import { loadMigration, verifyHarnessCheckout } from './migration-catalog.mjs'

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'])
const SOURCE_DIRS_TO_SKIP = new Set(['.git', 'node_modules', 'coverage'])
const ARTIFACT_DIRS = ['lib', 'dist', 'build', 'out']
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
const NON_RUNTIME_TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.snap'])

function extension(file) {
  const match = /\.[^.]+$/.exec(file)
  return match?.[0]
}

function walk(root, skip, files = []) {
  if (!existsSync(root)) return files
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.storybook') continue
    const file = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(file, skip, files)
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(entry.name))) files.push(file)
  }
  return files
}

function walkAll(root, skip, files = []) {
  if (!existsSync(root)) return files
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.storybook') continue
    const file = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walkAll(file, skip, files)
    } else if (entry.isFile() && !LOCKFILES.has(entry.name) && !entry.name.includes('.dsh-doctor-')) files.push(file)
  }
  return files
}

function artifactFiles(root) {
  return ARTIFACT_DIRS.flatMap(name => walk(join(root, name), new Set()))
}

function isTopLevelArtifact(root, file) {
  return ARTIFACT_DIRS.includes(relative(root, file).split(/[\\/]/)[0])
}

function scriptKind(file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX
  if (/\.[cm]?ts$/i.test(file)) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

function packageRoot(moduleName) {
  if (moduleName.startsWith('@')) return moduleName.split('/').slice(0, 2).join('/')
  return moduleName.split('/')[0]
}

function relativePath(root, file) {
  return relative(root, file).split('\\').join('/')
}

function location(source, node, pluginRoot) {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source))
  return { file: relativePath(pluginRoot, source.fileName), line: point.line + 1, column: point.character + 1 }
}

function moduleLiteral(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
  if (ts.isCallExpression(node) && node.arguments.length === 1 && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) return node.arguments[0]
  if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return node.name
  return undefined
}

function namedImports(node) {
  const bindings = node.importClause?.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return []
  return bindings.elements.map(item => ({
    imported: item.propertyName?.text ?? item.name.text,
    local: item.name.text,
    typeOnly: node.importClause.isTypeOnly || item.isTypeOnly,
  }))
}

function quoteModule(text) {
  return `'${text}'`
}

function importText(moduleName, specs, declarationTypeOnly = false) {
  const allType = declarationTypeOnly || specs.every(item => item.typeOnly)
  const members = specs.map(item => {
    const prefix = !allType && item.typeOnly ? 'type ' : ''
    return `${prefix}${item.imported}${item.local === item.imported ? '' : ` as ${item.local}`}`
  }).join(', ')
  return `import${allType ? ' type' : ''} { ${members} } from ${quoteModule(moduleName)}`
}

function analyzeFile(file, pluginRoot, catalog, origin) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const findings = []
  const replacements = []
  const exactTargets = new Map()
  const unresolved = []
  const removed = new Set(catalog.packages.removed)
  const handledLiterals = new WeakSet()

  function visit(node) {
    const literal = moduleLiteral(node)
    if (literal && ts.isStringLiteralLike(literal)) {
      handledLiterals.add(literal)
      const moduleName = literal.text
      const rootName = packageRoot(moduleName)
      if (removed.has(rootName)) {
        const where = location(source, literal, pluginRoot)
        const symbolRules = catalog.symbols.modules[moduleName]
        const specs = ts.isImportDeclaration(node) ? namedImports(node) : []
        const exact = []
        const remaining = []
        for (const spec of specs) {
          const rule = symbolRules?.[spec.imported]
          if (rule?.confidence === 'exact') {
            exact.push({ ...spec, imported: rule.toSymbol, toModule: rule.toModule, fromSymbol: spec.imported, reason: rule.reason })
            findings.push({ code: 'MIG_MOVED_SYMBOL', severity: 'error', message: `${spec.imported} moved to ${rule.toModule}`, location: where, evidence: { module: moduleName, symbol: spec.imported, targetModule: rule.toModule, replacement: rule.toSymbol }, autoFix: 'safe' })
          } else {
            remaining.push(spec)
            const semantic = rule?.confidence === 'semantic'
            findings.push({ code: semantic ? 'MIG_SEMANTIC_API_CHANGE' : 'MIG_REMOVED_PACKAGE_REFERENCE', severity: 'error', message: semantic ? `${spec.imported} requires a semantic migration: ${rule.reason}` : `${moduleName} was removed without a safe automatic replacement`, location: where, evidence: { module: moduleName, ...(spec.imported ? { symbol: spec.imported } : {}) }, autoFix: 'none' })
            unresolved.push({
              file: where.file,
              package: rootName,
              symbol: spec.imported,
              ...(rule?.toModule ? { targetModule: rule.toModule } : {}),
              ...(rule?.toSymbol ? { targetSymbol: rule.toSymbol } : {}),
              reason: rule?.reason ?? 'No exact replacement is known.',
            })
          }
        }
        const declarationText = ts.isImportDeclaration(node) ? text.slice(node.getStart(source), node.getEnd()) : ''
        const simpleNamedImport = exact.length > 0 && ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.name === undefined && node.attributes === undefined && node.assertClause === undefined && !/\/(?:\/|\*)/.test(declarationText)
        if (simpleNamedImport) {
          for (const item of exact) exactTargets.set(`${rootName}\0${item.toModule}`, {
            fromPackage: rootName,
            toPackage: packageRoot(item.toModule),
            relationship: 'client',
            typeOnly: item.typeOnly,
          })
          const groups = new Map()
          for (const item of exact) {
            const list = groups.get(item.toModule) ?? []
            list.push(item)
            groups.set(item.toModule, list)
          }
          const generated = [...groups].map(([target, items]) => importText(target, items, node.importClause.isTypeOnly))
          if (remaining.length > 0) generated.unshift(importText(moduleName, remaining, node.importClause.isTypeOnly))
          replacements.push({ start: node.getStart(source), end: node.getEnd(), next: generated.join('\n'), exact })
        } else if (specs.length === 0 || exact.length > 0) {
          for (const finding of findings) if (finding.code === 'MIG_MOVED_SYMBOL' && finding.location.line === where.line && exact.some(item => item.fromSymbol === finding.evidence.symbol)) finding.autoFix = 'none'
          findings.push({ code: 'MIG_REMOVED_PACKAGE_REFERENCE', severity: 'error', message: `${moduleName} was removed and this reference cannot be rewritten safely`, location: where, evidence: { module: moduleName, kind: ts.SyntaxKind[node.kind] }, autoFix: 'none' })
          unresolved.push({ file: where.file, package: rootName, module: moduleName, reason: 'Default, namespace, side-effect, export, require, dynamic import, or module augmentation reference.' })
        }
      }
    }
    if (ts.isStringLiteralLike(node) && !handledLiterals.has(node) && removed.has(packageRoot(node.text))) {
      const where = location(source, node, pluginRoot)
      findings.push({ code: 'MIG_REMOVED_PACKAGE_REFERENCE', severity: 'error', message: `string reference targets removed package ${node.text}`, location: where, evidence: { module: node.text, kind: 'string-literal' }, autoFix: 'none' })
      unresolved.push({ file: where.file, package: packageRoot(node.text), module: node.text, reason: 'A package-like string requires caller-specific review.' })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let nextText = text
  for (const edit of replacements.sort((a, b) => b.start - a.start)) nextText = `${nextText.slice(0, edit.start)}${edit.next}${nextText.slice(edit.end)}`
  return { file, origin, text, nextText, changed: nextText !== text, findings, unresolved, remainingPackages: [...new Set(unresolved.map(item => item.package))], exactTargets: [...exactTargets.values()] }
}

function readManifest(pluginRoot) {
  const file = join(pluginRoot, 'package.json')
  if (!existsSync(file)) throw new Error(`plugin manifest not found: ${file}`)
  const text = readFileSync(file, 'utf8')
  const value = JSON.parse(text)
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('plugin package.json must contain an object')
  return { file, value, text }
}

function targetVersion(name, catalog) {
  if (catalog.packages.targetVersions?.[name] !== undefined) return catalog.packages.targetVersions[name]
  return name.startsWith('@deepseek-ai/dsh-') ? catalog.manifest.to.version : undefined
}

function manifestFindings(manifest, catalog) {
  const findings = []
  for (const field of DEPENDENCY_FIELDS) {
    const dependencyMap = manifest.value[field]
    if (dependencyMap !== undefined && (dependencyMap === null || Array.isArray(dependencyMap) || typeof dependencyMap !== 'object')) {
      findings.push({ code: 'MIG_INVALID_MANIFEST', severity: 'error', message: `${field} must be an object`, location: { file: 'package.json' }, evidence: { field }, autoFix: 'none' })
      continue
    }
    for (const [name, range] of Object.entries(dependencyMap ?? {})) {
      if (catalog.packages.removed.includes(name)) {
        findings.push({ code: 'MIG_REMOVED_PACKAGE_REFERENCE', severity: 'error', message: `${field}.${name} targets a removed package`, location: { file: 'package.json' }, evidence: { field, package: name, range }, autoFix: 'conditional' })
        continue
      }
      const target = targetVersion(name, catalog)
      if (target === undefined) continue
      const validRange = typeof range === 'string' ? semver.validRange(range) : null
      if (validRange === null) findings.push({ code: 'MIG_INVALID_DEPENDENCY_RANGE', severity: 'error', message: `${field}.${name} has a non-registry range that cannot prove target compatibility`, location: { file: 'package.json' }, evidence: { field, package: name, range, target }, autoFix: field === 'devDependencies' ? 'safe' : 'none' })
      else if (!semver.satisfies(target, validRange)) findings.push({ code: field === 'peerDependencies' ? 'MIG_TARGET_PEER_RANGE_MISMATCH' : 'MIG_TARGET_DEPENDENCY_RANGE_MISMATCH', severity: field === 'optionalDependencies' ? 'warning' : 'error', message: `${field}.${name} does not accept ${target}`, location: { file: 'package.json' }, evidence: { field, package: name, range, target }, autoFix: field === 'devDependencies' ? 'safe' : 'none' })
    }
  }
  const client = manifest.value.dsh?.client
  if (client !== undefined && (client === null || Array.isArray(client) || typeof client !== 'object')) {
    findings.push({ code: 'MIG_INVALID_MANIFEST', severity: 'error', message: 'dsh.client must be an object', location: { file: 'package.json' }, evidence: { field: 'dsh.client' }, autoFix: 'none' })
    return findings
  }
  if (client !== undefined && typeof client.platform !== 'string') findings.push({ code: 'MIG_INVALID_MANIFEST', severity: 'error', message: 'dsh.client.platform must be a string', location: { file: 'package.json' }, evidence: { field: 'dsh.client.platform' }, autoFix: 'none' })
  if (client?.immediately !== undefined && typeof client.immediately !== 'boolean') findings.push({ code: 'MIG_INVALID_MANIFEST', severity: 'error', message: 'dsh.client.immediately must be a boolean', location: { file: 'package.json' }, evidence: { field: 'dsh.client.immediately' }, autoFix: 'none' })
  for (const field of ['inject', 'external']) {
    const values = client?.[field]
    if (values !== undefined && !Array.isArray(values)) {
      findings.push({ code: 'MIG_INVALID_MANIFEST', severity: 'error', message: `dsh.client.${field} must be an array`, location: { file: 'package.json' }, evidence: { field: `dsh.client.${field}` }, autoFix: 'none' })
      continue
    }
    for (const name of values ?? []) if (typeof name === 'string' && catalog.packages.removed.includes(packageRoot(name))) findings.push({ code: 'MIG_CLIENT_GRAPH_INVALID', severity: 'error', message: `dsh.client.${field} references removed package ${name}`, location: { file: 'package.json' }, evidence: { field, package: name }, autoFix: 'none' })
  }
  for (const name of Array.isArray(client?.external) ? client.external : []) if (catalog.configRules.platformModules.includes(name)) findings.push({ code: 'MIG_CLIENT_GRAPH_INVALID', severity: 'warning', message: `${name} is supplied by the 0.1.2 client baseline and should not be external`, location: { file: 'package.json' }, evidence: { field: 'external', package: name }, autoFix: 'none' })
  if (client && manifest.value.exports?.['./client'] === undefined) findings.push({ code: 'MIG_CLIENT_GRAPH_INVALID', severity: 'error', message: 'dsh.client requires a published exports["./client"] entry', location: { file: 'package.json' }, evidence: { field: 'exports./client' }, autoFix: 'none' })
  return findings
}

function opaqueReferenceFindings(pluginRoot, sourceFiles, manifest, catalog) {
  const analyzed = new Set(sourceFiles)
  const removed = catalog.packages.removed
  const findings = []
  const packages = new Set()
  for (const file of walkAll(pluginRoot, SOURCE_DIRS_TO_SKIP)) {
    if (isTopLevelArtifact(pluginRoot, file)) continue
    if (file === manifest.file || analyzed.has(file)) continue
    const stat = statSync(file)
    if (stat.size > 2 * 1024 * 1024) continue
    const buffer = readFileSync(file)
    if (buffer.includes(0)) continue
    const text = buffer.toString('utf8')
    for (const name of removed) {
      const index = text.indexOf(name)
      if (index < 0) continue
      const before = text.slice(0, index)
      const documentationOnly = NON_RUNTIME_TEXT_EXTENSIONS.has(extension(file))
      if (!documentationOnly) packages.add(name)
      findings.push({
        code: documentationOnly ? 'MIG_DOCUMENTATION_REFERENCE' : 'MIG_UNSUPPORTED_SOURCE_REFERENCE',
        severity: documentationOnly ? 'warning' : 'error',
        message: documentationOnly ? `${relativePath(pluginRoot, file)} documents removed package ${name}` : `${relativePath(pluginRoot, file)} references removed package ${name} in a file that has no safe codemod`,
        location: { file: relativePath(pluginRoot, file), line: before.split('\n').length, column: index - before.lastIndexOf('\n') },
        evidence: { package: name },
        autoFix: 'none',
      })
    }
  }
  const structuredFields = ['imports', 'exports', 'typesVersions', 'scripts']
  const structuredText = JSON.stringify(Object.fromEntries(structuredFields.filter(field => manifest.value[field] !== undefined).map(field => [field, manifest.value[field]])))
  for (const name of removed) {
    if (!structuredText.includes(name)) continue
    packages.add(name)
    findings.push({ code: 'MIG_UNSUPPORTED_SOURCE_REFERENCE', severity: 'error', message: `package.json contains a non-dependency reference to removed package ${name}`, location: { file: 'package.json' }, evidence: { package: name }, autoFix: 'none' })
  }
  return { findings, packages }
}

function patchTargetFindings(pluginRoot, manifest, harness) {
  if (!harness.exact) return []
  const declared = manifest.value.dsh?.bundle?.patch
  const paths = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter(item => typeof item === 'string') : []
  const fromIds = new Set(harness.fromEntryIds)
  const toIds = new Set(harness.toEntryIds)
  const findings = []
  for (const path of paths) {
    const file = resolve(pluginRoot, path)
    if (!existsSync(file)) continue
    const document = parseDocument(readFileSync(file, 'utf8'), {
      prettyErrors: false,
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    })
    if (document.errors.length > 0) continue
    const rows = document.toJS()
    if (!Array.isArray(rows)) continue
    const owned = new Set(rows.flatMap(row => Array.isArray(row?.insert) ? row.insert.map(item => item?.id).filter(Boolean) : []))
    for (const row of rows) {
      const id = row?.id
      if (typeof id !== 'string' || owned.has(id) || toIds.has(id)) continue
      findings.push({
        code: 'MIG_PATCH_TARGET_CHANGED',
        severity: 'error',
        message: fromIds.has(id) ? `patch target ${id} existed in 0.1.1 but is absent from 0.1.2` : `patch target ${id} is not present in the target Harness bundles`,
        location: { file: relativePath(pluginRoot, file) },
        evidence: { id, existedInSource: fromIds.has(id), existsInTarget: false },
        autoFix: 'none',
      })
    }
  }
  return findings
}

function planManifest(manifest, sourceResults, artifactResults, opaqueReferences, catalog) {
  const next = structuredClone(manifest.value)
  const exactTargets = sourceResults.flatMap(result => result.exactTargets)
  const sourceReferences = new Set(sourceResults.flatMap(result => result.remainingPackages))
  const artifactText = artifactResults.map(result => result.text).join('\n')
  const clientGraph = JSON.stringify(manifest.value.dsh?.client ?? {})
  for (const field of DEPENDENCY_FIELDS) {
    const deps = next[field]
    if (!deps || Array.isArray(deps) || typeof deps !== 'object') continue
    const presentRemoved = catalog.packages.removed.filter(name => deps[name] !== undefined)
    for (const removedPackage of presentRemoved) {
      const stillUsed = sourceReferences.has(removedPackage) || clientGraph.includes(removedPackage) || opaqueReferences.has(removedPackage) || (sourceResults.length === 0 && artifactText.includes(removedPackage))
      if (!stillUsed) delete deps[removedPackage]
    }
    if (field === 'devDependencies') {
      for (const [name, range] of Object.entries(deps)) {
        const target = targetVersion(name, catalog)
        if (target !== undefined && !catalog.packages.removed.includes(name) && (semver.validRange(range) === null || !semver.satisfies(target, range))) deps[name] = target
      }
    }
  }
  for (const move of new Map(exactTargets.map(item => [`${item.relationship}\0${item.toPackage}`, item])).values()) {
    const fields = catalog.packages.dependencyPolicies?.[move.toPackage]?.[move.relationship]
    const version = targetVersion(move.toPackage, catalog)
    if (!Array.isArray(fields) || version === undefined) continue
    for (const field of fields) {
      if (!DEPENDENCY_FIELDS.includes(field)) throw new Error(`migration catalog has an invalid dependency field ${field}`)
      const deps = next[field] ??= {}
      if (deps[move.toPackage] === undefined) deps[move.toPackage] = version
    }
  }
  const changes = []
  for (const field of DEPENDENCY_FIELDS) {
    const before = manifest.value[field] ?? {}
    const after = next[field] ?? {}
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[name] !== after[name]) changes.push({ kind: 'manifest-dependency', field, package: name, before: before[name] ?? null, after: after[name] ?? null })
    }
  }
  const nextText = changes.length > 0 ? `${JSON.stringify(next, null, 2)}\n` : manifest.text
  return { file: manifest.file, text: manifest.text, nextText, changed: nextText !== manifest.text, changes }
}

function summarize(findings, safeEdits, unresolved) {
  return {
    errors: findings.filter(item => item.severity === 'error').length,
    warnings: findings.filter(item => item.severity === 'warning').length,
    info: findings.filter(item => item.severity === 'info').length,
    safeEdits: safeEdits.length,
    semanticTasks: unresolved.length,
  }
}

function analysisInputs(root) {
  return walkAll(root, SOURCE_DIRS_TO_SKIP)
    .map(file => ({ file: relativePath(root, file), hash: sha256File(file) }))
    .sort((left, right) => left.file.localeCompare(right.file))
}

export function analyzeMigration(pluginRoot = process.cwd(), options = {}) {
  const root = resolve(pluginRoot)
  if (!statSync(root).isDirectory()) throw new Error(`plugin root is not a directory: ${root}`)
  const catalog = loadMigration(options.from ?? 'dsh-v0.1.1-rc.2', options.to ?? 'dsh-v0.1.2-alpha.2')
  const harness = verifyHarnessCheckout(catalog, options.harnessRoot)
  const manifest = readManifest(root)
  const sourceFiles = walk(root, SOURCE_DIRS_TO_SKIP).filter(file => !isTopLevelArtifact(root, file))
  const sources = sourceFiles.map(file => analyzeFile(file, root, catalog, 'source'))
  const artifacts = artifactFiles(root).map(file => analyzeFile(file, root, catalog, 'artifact'))
  const opaqueReferences = opaqueReferenceFindings(root, sourceFiles, manifest, catalog)
  const sourceRemoved = sources.some(item => item.findings.some(finding => ['MIG_REMOVED_PACKAGE_REFERENCE', 'MIG_SEMANTIC_API_CHANGE', 'MIG_MOVED_SYMBOL'].includes(finding.code)))
  const artifactRemoved = artifacts.some(item => item.findings.some(finding => ['MIG_REMOVED_PACKAGE_REFERENCE', 'MIG_SEMANTIC_API_CHANGE', 'MIG_MOVED_SYMBOL'].includes(finding.code)))
  const findings = [...manifestFindings(manifest, catalog), ...patchTargetFindings(root, manifest, harness), ...sources.flatMap(item => item.findings), ...opaqueReferences.findings, ...artifacts.flatMap(item => item.findings)]
  if (!sourceRemoved && artifactRemoved) findings.push({ code: 'MIG_SOURCE_ARTIFACT_DRIFT', severity: 'error', message: 'built artifacts still reference removed APIs although source files do not', location: { file: '.' }, evidence: { artifactDirectories: ARTIFACT_DIRS }, autoFix: 'none' })
  findings.push({ code: 'MIG_RUNTIME_VERIFICATION_REQUIRED', severity: 'info', message: 'static analysis cannot prove activation and lifecycle behavior; run migrate verify --level runtime', location: { file: '.' }, evidence: {}, autoFix: 'none' })
  const manifestPlan = planManifest(manifest, sources, artifacts, opaqueReferences.packages, catalog)
  const changed = [...sources.filter(item => item.changed), ...(manifestPlan.changed ? [manifestPlan] : [])]
  const safeEdits = changed.map(item => ({
    file: relativePath(root, item.file),
    beforeHash: sha256(item.text),
    afterHash: sha256(item.nextText),
    changes: item.changes ?? item.findings.filter(finding => finding.autoFix === 'safe').map(finding => ({ kind: 'move-import', ...finding.evidence })),
  }))
  const unresolved = [...sources, ...artifacts].flatMap(item => item.unresolved)
  return {
    schemaVersion: 1,
    command: 'migrate analyze',
    migration: { id: catalog.manifest.id, from: catalog.manifest.from, to: catalog.manifest.to, references: catalog.manifest.references ?? {}, harness },
    plugin: { root, name: manifest.value.name ?? basename(root), version: manifest.value.version ?? 'unknown', manifestFile: manifest.file, packageManager: existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm' },
    summary: summarize(findings, safeEdits, unresolved),
    findings,
    safeEdits,
    semanticTasks: unresolved,
    sourceInvestigation: {
      required: harness.exact !== true || unresolved.length > 0,
      targetRef: catalog.manifest.to.ref,
      catalogReferences: catalog.manifest.references ?? {},
      semanticTargets: [...new Set(unresolved.map(item => item.targetModule).filter(Boolean))],
    },
    verification: { status: 'analyzed', level: 'static-analysis', passed: findings.every(item => item.severity !== 'error') },
    _inputs: analysisInputs(root),
    _plan: changed.map(item => ({ file: item.file, snapshot: { file: item.file, exists: true, hash: sha256(item.text) }, nextText: item.nextText })),
  }
}

export function publicMigrationReport(report) {
  const { _inputs, _plan, ...value } = report
  const harness = { ...value.migration.harness }
  delete harness.fromEntryIds
  delete harness.toEntryIds
  return { ...value, migration: { ...value.migration, harness } }
}

export function createMigrationPlan(report) {
  const publicReport = publicMigrationReport(report)
  const payload = {
    schemaVersion: 1,
    command: 'migrate apply plan',
    plugin: { root: report.plugin.root, manifestFile: report.plugin.manifestFile },
    migration: {
      id: report.migration.id,
      from: report.migration.from.ref,
      to: report.migration.to.ref,
      harness: {
        status: report.migration.harness.status,
        fromCommit: report.migration.harness.fromCommit,
        toCommit: report.migration.harness.toCommit,
      },
    },
    reportHash: sha256(JSON.stringify(publicReport)),
    inputs: report._inputs,
    edits: report.safeEdits,
  }
  return { ...payload, planId: sha256(JSON.stringify(payload)) }
}

function readMigrationPlan(file) {
  const value = JSON.parse(readFileSync(resolve(file), 'utf8'))
  if (value?.schemaVersion !== 1 || value.command !== 'migrate apply plan' || typeof value.planId !== 'string') throw new Error('invalid migration plan file')
  const { planId, ...payload } = value
  if (sha256(JSON.stringify(payload)) !== planId) throw new Error('migration plan file digest does not match its contents')
  return value
}

function assertMigrationPlan(report, plan) {
  const current = createMigrationPlan(report)
  if (plan.plugin.root !== current.plugin.root || plan.plugin.manifestFile !== current.plugin.manifestFile) throw new Error('migration plan targets a different plugin')
  if (plan.migration.id !== current.migration.id || plan.migration.from !== current.migration.from || plan.migration.to !== current.migration.to) throw new Error('migration plan targets a different catalog')
  if (plan.reportHash !== current.reportHash || JSON.stringify(plan.inputs) !== JSON.stringify(current.inputs) || JSON.stringify(plan.edits) !== JSON.stringify(current.edits)) throw new Error('plugin analysis changed after the preview; create and review a new migration plan')
  return current
}

export function applyMigration(report, options = {}) {
  if (options.safe !== true) throw new Error('migrate apply requires --safe')
  if (options.planFile === undefined) throw new Error('migrate apply requires --plan-file so the confirmed preview can be verified')
  const planFile = resolve(options.planFile)
  const planRelative = relative(report.plugin.root, planFile)
  if (planRelative === '' || (planRelative !== '..' && !planRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(planRelative))) throw new Error('migration plan file must be outside the plugin root')
  if (options.yes !== true) {
    const plan = createMigrationPlan(report)
    writeNewFile(planFile, `${JSON.stringify(plan, null, 2)}\n`)
    return { mode: 'preview', plan: { file: planFile, id: plan.planId }, ...publicMigrationReport(report) }
  }
  const plan = readMigrationPlan(planFile)
  const verifiedPlan = assertMigrationPlan(report, plan)
  // Exact edits remain safe when semantic work remains; unresolved references keep the removed dependency.
  for (const item of report._plan) {
    const currentExists = existsSync(item.snapshot.file)
    const current = currentExists ? readFileSync(item.snapshot.file, 'utf8') : ''
    if (currentExists !== item.snapshot.exists || sha256(current) !== item.snapshot.hash) throw new Error(`${item.snapshot.file} changed after the preview; diagnose again before applying`)
  }
  const writes = report._plan.map(item => ({ ...atomicWrite(item.snapshot, item.nextText), beforeHash: item.snapshot.hash, afterHash: sha256(item.nextText) }))
  const verification = analyzeMigration(report.plugin.root, { from: report.migration.from.ref, to: report.migration.to.ref, harnessRoot: report.migration.harness.root })
  return { mode: 'applied', plan: { file: planFile, id: verifiedPlan.planId }, writes, report: publicMigrationReport(verification) }
}

export function formatMigrationReport(report, language = 'en') {
  const zh = language === 'zh'
  const lines = [
    `${zh ? '插件升级分析' : 'Plugin migration analysis'}: ${report.plugin.name}@${report.plugin.version}`,
    `${report.migration.from.ref} -> ${report.migration.to.ref} (${report.migration.harness.status})`,
    `${zh ? '结果' : 'Result'}: ${report.summary.errors} ${zh ? '错误' : 'errors'}, ${report.summary.warnings} ${zh ? '警告' : 'warnings'}, ${report.summary.safeEdits} ${zh ? '个安全改写' : 'safe edits'}, ${report.summary.semanticTasks} ${zh ? '个语义任务' : 'semantic tasks'}`,
  ]
  for (const finding of report.findings) lines.push(`- [${finding.severity}] ${finding.code} ${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ''}: ${finding.message}`)
  if (report.safeEdits.length > 0) {
    lines.push(zh ? '可安全改写：' : 'Safe edit preview:')
    for (const edit of report.safeEdits) {
      lines.push(`  ${edit.file} ${edit.beforeHash.slice(0, 8)} -> ${edit.afterHash.slice(0, 8)}`)
      for (const change of edit.changes) {
        if (change.kind === 'move-import') lines.push(`    ${change.symbol}: ${change.module} -> ${change.targetModule}#${change.replacement}`)
        else lines.push(`    ${change.field}.${change.package}: ${change.before ?? '(absent)'} -> ${change.after ?? '(removed)'}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}
