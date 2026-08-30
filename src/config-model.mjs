import { readFileSync } from 'node:fs'

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function source(layer, patchIndex) {
  return {
    kind: layer.kind,
    file: layer.file,
    patchIndex,
    ...(layer.package === undefined ? {} : { package: layer.package }),
  }
}

function leafPaths(value, prefix = '') {
  const object = record(value)
  if (object === undefined) return prefix === '' ? [] : [prefix]
  const paths = Object.entries(object).flatMap(([key, child]) => leafPaths(child, prefix === '' ? key : `${prefix}.${key}`))
  return paths.length === 0 && prefix !== '' ? [prefix] : paths
}

function makeEntry(value, origin) {
  const entry = structuredClone(value)
  const fields = {}
  for (const [key, fieldValue] of Object.entries(entry)) {
    fields[key] = { value: structuredClone(fieldValue), source: origin }
  }
  return { value: entry, origin, fields }
}

function flatten(nodes, result = []) {
  for (const node of nodes) {
    result.push({
      ...structuredClone(node.value),
      origin: node.origin,
      fields: node.fields,
    })
    if (node.value.group && Array.isArray(node.children)) flatten(node.children, result)
  }
  return result
}

function publicTree(nodes) {
  return nodes.map(node => ({
    ...structuredClone(node.value),
    ...(node.children === undefined ? {} : { config: publicTree(node.children) }),
    origin: node.origin,
    fields: node.fields,
  }))
}

function compose(layers, onIssue) {
  const roots = []
  const idMap = new Map()
  const register = (node, layer, patchIndex) => {
    const id = node.value.id
    if (typeof id === 'string' && id.length > 0) {
      if (idMap.has(id)) onIssue('DUPLICATE_ENTRY_ID', layer, patchIndex, node.value, { id })
      idMap.set(id, node)
    }
    if (node.value.group && Array.isArray(node.value.config)) {
      node.children = node.value.config.map(value => makeEntry(value, node.origin))
      delete node.value.config
      for (const child of node.children) register(child, layer, patchIndex)
    } else if (node.value.group && Object.hasOwn(node.value, 'config')) {
      onIssue('INVALID_GROUP_CONFIG', layer, patchIndex, node.value, { actualType: node.value.config === null ? 'null' : typeof node.value.config })
    }
  }
  for (const layer of layers) {
    layer.patches.forEach((patch, patchIndex) => {
      const at = source(layer, patchIndex)
      if (Array.isArray(patch.insert)) {
        let destination = roots
        if (typeof patch.id === 'string' && patch.id.length > 0) {
          const target = idMap.get(patch.id)
          if (target === undefined || !target.value.group) return
          if (target.children === undefined) target.children = []
          destination = target.children
        }
        for (const value of patch.insert) {
          const node = makeEntry(value, at)
          destination.push(node)
          register(node, layer, patchIndex)
        }
        return
      }
      if (typeof patch.id !== 'string' || patch.id.length === 0) return
      const target = idMap.get(patch.id)
      if (target === undefined || (patch.name !== undefined && patch.name !== target.value.name)) return
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'insert' || key === 'name') continue
        const previous = target.fields[key]
        const removedPaths = key === 'config' && previous !== undefined
          ? leafPaths(previous.value).filter(path => !leafPaths(value).includes(path))
          : []
        target.value[key] = structuredClone(value)
        target.fields[key] = {
          value: structuredClone(value),
          source: at,
          ...(previous === undefined ? {} : { replacedSource: previous.source }),
          ...(removedPaths.length === 0 ? {} : { removedPaths }),
        }
        if (key === 'config' && target.value.group) {
          // A complete override always discards the old public children. Keep
          // the application index unchanged (applyEntryPatches does not index
          // config overrides), but only rebuild children for a valid array.
          delete target.children
          if (Array.isArray(value)) {
            target.children = value.map(child => makeEntry(child, at))
            delete target.value.config
          } else {
            onIssue('INVALID_GROUP_CONFIG', layer, patchIndex, target.value, { actualType: value === null ? 'null' : typeof value })
          }
        }
        if (key === 'disabled' && value === true && layer.kind !== 'bundle') {
          onIssue('CORE_ENTRY_DISABLED_BY_HIGHER_LAYER', layer, patchIndex, target.value, { origin: target.origin })
        }
        if (key === 'config' && previous !== undefined && layer.kind !== 'bundle' && previous.source.file !== at.file) {
          onIssue(target.value.group ? 'GROUP_CONTENT_REPLACED' : 'CONFIG_REPLACED_BY_HIGHER_LAYER', layer, patchIndex, target.value, { removedPaths })
        }
        if (key === 'group' && layer.kind !== 'bundle') onIssue('ENTRY_STRUCTURE_OVERRIDDEN', layer, patchIndex, target.value, {})
      }
    })
  }
  const entries = flatten(roots)
  const names = new Map()
  for (const entry of entries) {
    if (entry.disabled === true || typeof entry.name !== 'string' || entry.name.length === 0) continue
    const mounted = names.get(entry.name) ?? []
    mounted.push(entry.id)
    names.set(entry.name, mounted)
  }
  for (const [name, ids] of names) {
    if (ids.length > 1) onIssue('DUPLICATE_PLUGIN_MOUNT', undefined, undefined, { name }, { ids })
  }
  return { tree: publicTree(roots), entries }
}

export function buildConfigurationModel(layers, addFinding) {
  const issues = []
  const onIssue = (code, layer, patchIndex, entry, details) => {
    const issue = {
      code,
      layer,
      patchIndex,
      entry,
      details,
    }
    issues.push(issue)
    if (addFinding !== undefined) addFinding(issue)
  }
  const bundleLayers = layers.filter(layer => layer.kind === 'bundle')
  const currentDefault = compose(bundleLayers, () => {})
  const currentEffective = compose(layers, onIssue)
  return {
    layers: layers.map(layer => ({ kind: layer.kind, file: layer.file, label: layer.label, package: layer.package })),
    currentDefaultTree: currentDefault.tree,
    currentEffectiveTree: currentEffective.tree,
    entries: currentEffective.entries,
    issues,
  }
}

export function readPatchText(file) {
  return readFileSync(file, 'utf8')
}
