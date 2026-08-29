import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

const SUPPORTED = new Map([
  ['en', 'en'],
  ['en-us', 'en'],
  ['en_us', 'en'],
  ['zh', 'zh'],
  ['zh-cn', 'zh'],
  ['zh_cn', 'zh'],
  ['zh-hans', 'zh'],
])

function normalizedLanguage(value) {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().split('.')[0].toLowerCase()
  if (cleaned === '' || cleaned === 'auto' || cleaned === 'c' || cleaned === 'posix') return undefined
  return SUPPORTED.get(cleaned) ?? SUPPORTED.get(cleaned.split(/[-_]/)[0])
}

function dshPreference(home) {
  const file = join(home, 'settings.yaml')
  if (!existsSync(file)) return undefined
  try {
    const document = parseDocument(readFileSync(file, 'utf8'), { prettyErrors: false })
    if (document.errors.length > 0) return undefined
    return document.toJS()?.locale?.preference
  } catch {
    return undefined
  }
}

export function resolveLanguage({ requested, env = process.env, home, systemLocale } = {}) {
  if (requested !== undefined && requested !== 'auto') {
    const language = normalizedLanguage(requested)
    if (language === undefined) throw new Error(`unsupported language ${JSON.stringify(requested)}; expected auto, zh, or en`)
    return language
  }
  const configured = normalizedLanguage(env.DSH_DOCTOR_LANG)
  if (configured !== undefined) return configured
  const preference = normalizedLanguage(home === undefined ? undefined : dshPreference(home))
  if (preference !== undefined) return preference
  for (const value of [env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE, systemLocale]) {
    const language = normalizedLanguage(value)
    if (language !== undefined) return language
  }
  return 'en'
}

function captured(message, pattern, index = 1) {
  return message.match(pattern)?.[index]
}

const ZH_MESSAGES = {
  FILE_READ_FAILED: item => `无法读取${captured(item.message, /^Cannot read (.+)\.$/) ?? '文件'}。`,
  INVALID_JSON_OBJECT: item => `${captured(item.message, /^(.+) must contain a JSON object\.$/) ?? '该文件'}必须包含 JSON 对象。`,
  INVALID_JSON: item => `${captured(item.message, /^(.+) is not valid JSON\.$/) ?? '该文件'}不是有效的 JSON。`,
  PACKAGE_NAME_MISMATCH: item => `${item.package ?? '依赖'}解析到了名称不匹配的包。`,
  INVALID_HARNESS_ROOT: () => '指定的 Harness 根目录不是有效的源码工作区。',
  INVALID_WORKSPACE_MANIFEST: () => '已忽略一个无效的 Harness workspace 包清单。',
  HARNESS_INSTALLATION_UNKNOWN: () => '无法定位这个 DSH Home 实际使用的 Harness。',
  INVALID_DEPENDENCY_MAP: item => `${captured(item.message, /^(\S+) must be/) ?? '依赖字段'}必须是“包名到版本范围”的对象。`,
  INVALID_CLIENT_DECLARATION: item => `${item.package} 的 dsh.client 声明无效。`,
  INVALID_CLIENT_PLATFORM: item => `${item.package} 的 dsh.client.platform 必须是字符串。`,
  INVALID_CLIENT_IMMEDIATELY: item => `${item.package} 的 dsh.client.immediately 必须是布尔值。`,
  INVALID_CLIENT_EXTERNAL: item => `${item.package} 的 dsh.client.external 必须是字符串数组。`,
  INVALID_CLIENT_INJECT: item => `${item.package} 的 dsh.client.inject 必须是字符串数组。`,
  CLIENT_EXPORT_MISSING: item => `${item.package} 声明了 dsh.client，但没有导出 ./client 入口。`,
  CLIENT_BUNDLE_MISSING: item => `${item.package} 的客户端 bundle 缺失。`,
  CLIENT_BUNDLE_UNREADABLE: item => `无法读取 ${item.package} 的客户端 bundle。`,
  UNDECLARED_CLIENT_REQUIRE: item => `${item.package} 引用了 ${captured(item.message, / requires (.+) but does not/) ?? '未声明模块'}，但没有在 dsh.client.external 中声明。`,
  REDUNDANT_CLIENT_EXTERNAL: item => `${item.package} 把平台模块 ${captured(item.message, / module (.+) as an external/) ?? ''} 重复声明为 external。`,
  CLIENT_EXTERNAL_WITHOUT_SUPPLIER: item => `${item.package} 请求了 ${captured(item.message, / requests (.+), but/) ?? '客户端模块'}，但当前 Harness 没有对应的模块提供方。`,
  REMOVED_CLIENT_INJECT: item => `${item.package} 注入了 ${captured(item.message, / injects (.+), which/) ?? '已移除的模块'}，但当前 Harness 源码中已不存在该模块。`,
  LEGACY_HARNESS_PEERS: item => `${item.package} 仍声明了当前 Harness 源码中已不存在的旧包。`,
  BUNDLE_NOT_INSTALLED: item => `配置中的 bundle ${item.package} 尚未安装。`,
  BUNDLE_DECLARATION_MISSING: item => `${item.package} 被列为 profile bundle，但没有声明 dsh.bundle.patch。`,
  BUNDLE_PATCH_MISSING: item => `${item.package} 的 bundle patch 文件缺失。`,
  INVALID_PATCH_YAML: item => `${captured(item.message, /^(.+) cannot be parsed\.$/) ?? 'Patch 文件'}无法解析。`,
  INVALID_PATCH_LIST: item => `${captured(item.message, /^(.+) must be/) ?? 'Patch 文件'}的顶层必须是由映射组成的 YAML 数组。`,
  INVALID_SETTINGS_DOCUMENT: () => 'Harness 设置文件无法解析。',
  INVALID_SETTINGS_ROOT: () => 'Harness 设置文件顶层必须是命名空间映射。',
  INVALID_CREDENTIALS_DOCUMENT: () => 'Harness 凭据文件无法解析。',
  INVALID_CREDENTIALS_ROOT: () => 'Harness 凭据文件顶层必须是映射。',
  INVALID_CREDENTIALS_LAYOUT: () => 'Harness 凭据文件不是受支持的 version 1 结构。',
  HARNESS_PEER_VERSION_MISMATCH: item => `${item.package} 声明的 Harness peer 版本范围不接受当前已安装版本。`,
  INVALID_PROFILE_NAME: item => `Profile 名称无效：${captured(item.message, /^Invalid profile name (.+)\.$/) ?? ''}`,
  PROFILE_NOT_FOUND: item => `Profile ${captured(item.message, /^Profile (.+) does not exist\.$/) ?? ''} 不存在。`,
  INVALID_DSH_CONFIGURATION: () => 'dsh 字段存在时必须是对象。',
  INVALID_PROFILE_CONFIGURATION: () => 'dsh.profile 字段存在时必须是对象。',
  INVALID_BUNDLE_LIST: () => 'dsh.profile.bundles 必须是字符串数组。',
  INVALID_PATCH_RELOAD: () => 'dsh.profile.patchReload 必须是 “live” 或 “startup”。',
  DEPENDENCY_NOT_INSTALLED: item => `Profile 依赖 ${item.package} 尚未安装。`,
  PROFILE_DEPENDENCY_VERSION_MISMATCH: item => `${item.package} 的声明版本范围与当前安装版本不兼容。`,
  INSTALLED_BUNDLE_INACTIVE: item => `${item.package} 已作为 bundle 安装，但不在 dsh.profile.bundles 中。`,
}

const ZH_SUGGESTIONS = {
  INVALID_JSON_OBJECT: () => '启动 Harness 前，请恢复有效的 package manifest 对象。',
  INVALID_JSON: () => '启动该 profile 前，请先修复 JSON。',
  PACKAGE_NAME_MISMATCH: () => '重新安装依赖，使目录位置与包名一致。',
  INVALID_HARNESS_ROOT: () => '诊断源码工作区时，请把 DeepSeek Harness 仓库根目录传给 --harness-root。',
  INVALID_WORKSPACE_MANIFEST: () => '修复该 workspace 包清单后，Doctor 才能把它纳入兼容性检查。',
  HARNESS_INSTALLATION_UNKNOWN: () => '若使用源码工作区，请通过 --harness-root 明确指定；若使用独立 CLI，请通过 --dsh-command 指定。',
  INVALID_DEPENDENCY_MAP: () => '管理或启动 profile 前，请先修复这个依赖字段。',
  INVALID_CLIENT_DECLARATION: update,
  INVALID_CLIENT_PLATFORM: update,
  INVALID_CLIENT_IMMEDIATELY: update,
  INVALID_CLIENT_EXTERNAL: update,
  INVALID_CLIENT_INJECT: update,
  CLIENT_EXPORT_MISSING: update,
  CLIENT_BUNDLE_MISSING: update,
  UNDECLARED_CLIENT_REQUIRE: update,
  CLIENT_EXTERNAL_WITHOUT_SUPPLIER: update,
  REMOVED_CLIENT_INJECT: update,
  REDUNDANT_CLIENT_EXTERNAL: () => '插件作者应删除重复的 dsh.client.external 条目。',
  LEGACY_HARNESS_PEERS: () => '该插件存在兼容风险，请在下次升级 Harness 前更新。',
  BUNDLE_NOT_INSTALLED: () => '使用当前 DSH 安装补齐 profile 依赖、升级 bundle，或从 profile 中移除它。',
  BUNDLE_DECLARATION_MISSING: () => '升级该 bundle，或把它从 dsh.profile.bundles 中移除。',
  BUNDLE_PATCH_MISSING: () => '重新安装或升级该 bundle，或者从 profile 中移除它。',
  INVALID_PATCH_YAML: () => '启动该 profile 前，请修复 YAML 语法。',
  INVALID_PATCH_LIST: () => '启动该 profile 前，请修复 patch 顶层结构。',
  INVALID_SETTINGS_DOCUMENT: () => '修复设置文件语法；Doctor 不会猜测凭据或模型配置值。',
  INVALID_SETTINGS_ROOT: () => '把顶层标量或数组替换为映射。',
  INVALID_CREDENTIALS_DOCUMENT: () => '只修复报告的结构；Doctor 永远不会输出或重写秘密值。',
  INVALID_CREDENTIALS_LAYOUT: () => '迁移文档结构，不要暴露或修改秘密值。',
  HARNESS_PEER_VERSION_MISMATCH: item => `把 ${item.package} 更新到兼容当前 Harness 的版本。`,
  PROFILE_NOT_FOUND: () => '先启动一次该 profile，或用当前 DSH 安装初始化它。',
  INVALID_DSH_CONFIGURATION: () => '启动 Harness 前，请先修复 dsh 配置对象。',
  INVALID_PROFILE_CONFIGURATION: () => '启动 Harness 前，请先修复 dsh.profile 配置对象。',
  INVALID_BUNDLE_LIST: () => '启动 Harness 前，请修复 profile manifest。',
  INVALID_PATCH_RELOAD: () => '选择该 profile 需要的 reload 生命周期。',
  DEPENDENCY_NOT_INSTALLED: () => '使用下方精确命令安装该 profile 声明的依赖。',
  PROFILE_DEPENDENCY_VERSION_MISMATCH: () => '使用下方精确命令重新同步该 profile 的安装。',
  INSTALLED_BUNDLE_INACTIVE: () => '重新执行匹配的插件添加或更新操作，或者移除未使用的依赖。',
}

function update(item) {
  return `更新 ${item.package}；如果没有兼容版本，再通过同一个 DSH 安装移除该插件。`
}

export function localizedFinding(item, language) {
  if (language !== 'zh') return item
  const message = ZH_MESSAGES[item.code]?.(item) ?? item.message
  const suggestion = item.suggestion === undefined ? undefined : (ZH_SUGGESTIONS[item.code]?.(item) ?? item.suggestion)
  const evidence = typeof item.evidence === 'string'
    ? item.evidence.replaceAll('(active ', '(当前 ').replace(/ at line (\d+), column (\d+)/g, '，第 $1 行第 $2 列')
    : item.evidence
  return { ...item, message, suggestion, evidence }
}

export function languageName(language) {
  return language === 'zh' ? '中文' : 'English'
}
