# 更新日志

每个发布版本都必须在这里提供中文说明。GitHub Actions 会根据 tag 提取对应条目，自动创建或更新 GitHub Release；缺少条目或条目不包含中文时，发布流程会失败。

## v0.5.4

### 主要更新

- 为 `dsh-plugin-upgrade` 增加兼容性决策门：升级请求未明确时，允许先做只读分析，但在迁移写入、依赖安装、构建或运行时验证前必须询问开发者，是仅支持 DSH 0.1.2，还是同一插件版本继续兼容 0.1.1。
- 新增双版本兼容策略说明；0.1.2 catalog 的安全 codemod 在双版本模式下只作为候选修改，需要逐项复核旧版，且必须分别验证 0.1.1 与 0.1.2 的构建、产物、隔离运行和业务行为。
- 扩充 skill eval，覆盖兼容意图缺失、明确要求同一发布版本双兼容，以及单一产物不可行时不得静默放弃旧版的场景。

### 安装

```sh
npm install --global @bruc3van/dsh-doctor@0.5.4
npx skills add bruc3van/dsh-doctor
```

### 验证

- 完成 skill 结构、98 项测试和 npm 发布包内容检查；新增测试确保兼容决策门、双版本验证要求和中英文 CLI 测试不受本机语言环境影响。

## v0.5.3

### 主要更新

- 重构中英文 README，把 `dsh-plugin-upgrade` skill 的安装和使用放在前面，用更直接的方式说明 Agent、CLI 与 migration catalog 如何配合完成插件代码迁移、重新构建和验证。
- 对外统一描述为帮助插件从 DSH 0.1.1 升级到 0.1.2；`dsh-v0.1.1-rc.2` 与 `dsh-v0.1.2-alpha.2` 保留为当前 catalog 的精确参考点，其他 patch 或预发布组合需要核对实际差异。
- 补充源码、依赖、client graph、构建产物、隔离运行时的覆盖范围，以及只读分析、精确 codemod、显式确认、备份、写入保护和脱敏等安全边界。
- 同步更新 skill 描述、实际版本范围检查、发布准备说明和 eval；明确 Skill 只引导工作流程，不会自动修改全局 CLI、提交或发布插件。

### 安装

```sh
npx skills add bruc3van/dsh-doctor
```

### 验证

- 完成 skill 结构、95 项测试、npm 打包内容和远程 skill 安装检查，并由发布 CI 覆盖 macOS、Ubuntu、Windows 与 Node.js 22.19/24。

## v0.5.2

### 主要更新

- 为 `dsh-plugin-upgrade` skill 增加完整 CLI bootstrap：检查 Node.js、本地 DSH Doctor 版本和目标 migration catalog，并通过只读 `npm view` 检查 registry 最新版本。
- 本地 CLI 缺失、过期或缺少 catalog 时，默认使用解析后的精确 npm 版本执行 npx，并在 analyze、apply、verify 三阶段保持同一版本，避免多次使用 `@latest` 产生漂移。
- 明确 skill 安装不授权全局 npm 写入；只有用户显式确认后才允许全局安装或更新，并要求安装后重新核验版本和 catalog。
- 新增 CLI 缺失/过期场景的 skill eval，要求报告本地版本、registry 版本、最终选择、catalog 证据和更新状态。

### 安装

```sh
npx skills add bruc3van/dsh-doctor
```

### 验证

- 验证独立安装后的 skill 包含 CLI bootstrap reference 与新增 eval，并完成 skill 结构、95 项测试、完整 CI 矩阵和 npm 打包内容检查。

## v0.5.1

### 主要更新

- 重写中英文 README 的信息结构，补全插件迁移三阶段、主要 API 所有权变化、诊断、恢复决策、退出码和安全边界说明。
- 支持通过 `npx skills add bruc3van/dsh-doctor` 从 GitHub 仓库直接发现并安装 `dsh-plugin-upgrade` skill，并明确 skill 安装与 CLI 安装的边界。
- 修正独立安装 skill 后失效的 monorepo 相对 catalog 链接，并准确区分 static gate 的 AST/manifest/产物检查与 build gate 中可选的 TypeScript typecheck 脚本。

### 安装

```sh
npm install --global @bruc3van/dsh-doctor@0.5.1
npx skills add bruc3van/dsh-doctor
```

### 验证

- 验证 `skills` CLI 能从仓库发现唯一的 `dsh-plugin-upgrade` skill，并完成 skill 结构、完整测试矩阵和 npm 打包内容检查。

## v0.5.0

### 主要更新

- 新增 `migrations list` 与版本化迁移 catalog，首个迁移覆盖 `dsh-v0.1.1-rc.2` 到 `dsh-v0.1.2-alpha.2`，并固定两端 tag commit、移除/新增包、精确符号映射、语义所有权变化和 client graph 规则。
- 新增 `migrate analyze`，使用 TypeScript AST 同时检查源码、`import type`、动态引用、非 JS/TS 配置与组件引用、package manifest、DSH/Cordis peer range、client inject/external 和构建产物，输出稳定 JSON finding code 与语义待办；官方 patch target 只取 web profile 的正式 bundle，排除测试 fixture。
- 新增 `migrate apply --safe`：默认仅预览，只改写 catalog 确认的 exact 符号；显式 `--yes` 后进行 SHA-256 并发校验、同目录原子写入和时间戳备份，语义 API 不做机械替换。
- 新增 `migrate verify --level static|build|runtime`；构建和运行时执行需 `--yes`，artifact gate 要求真实 `build`/`pack:check` 并在首个失败处停止；运行时从真实插件 tarball 创建隔离 `DSH_HOME`，核验目标 CLI 版本、profile、安装包、bundle、有效配置和激活 smoke，失败时保留现场。
- 迁移报告中的相对文件路径统一使用跨平台 `/`，项目脚本通过跨平台命令解析执行，确保 Windows 下的 build/runtime gate 与 macOS、Linux 行为一致。
- 随 npm 包提供 `dsh-plugin-upgrade` skill、迁移参考资料与三类评测场景，明确 `analyzed`、`source-migrated`、`artifact-verified`、`runtime-verified` 和独立业务行为验证边界。

### 安装

```sh
npm install --global @bruc3van/dsh-doctor@0.5.0
dsh-doctor migrations list
```

### 验证

- 新增类型导入、独立字符串与 Vue/tsconfig/package imports 引用、混合精确/语义符号、备份、依赖范围、正式 patch target、产物门槛、空操作 CLI 拒绝、真实打包与临时 DSH_HOME 隔离回归测试。

## v0.4.0

### 主要更新

- 将诊断输出升级为逐插件“诊断与恢复决策”：兼容状态、故障原因、配置来源、版本检查和恢复选项彼此分离。
- 按当前 DSH 的 bundle、profile、home 层级重建默认/生效配置树，记录字段级来源、被替换来源和整体替换丢失路径，并新增旧 patch、重复 mount、entry 冲突和高层覆盖诊断。
- 新增显式 npm registry 兼容版本检查；遍历所有已发布 manifest，选择声明兼容当前 DSH 的最高精确版本，不把 `latest` 或离线状态误报为可用结论。
- 新增 `recover <package>`，支持精确版本更新、临时 quarantine overlay、经 `--verified` 门控的持久隔离，以及独立、显式确认的安全删除。
- `recover`/`baseline` 与旧式 `--fix` 严格互斥；健康插件不会被推荐隔离，删除预检和删除后验证会保留 disabled 手工 mount 与 dangling patch，并要求预览阶段即可生成完整 quarantine。
- 持久 quarantine 追加最终生效覆盖并逐个核验目标 entry；group config 整体替换会重建生效树；显式 Harness workspace 不再混入 profile 残留包版本，已确认的 client contract 错误会输出确定原因。
- JSON、baseline 和删除前恢复快照会脱敏所有插件 config 值及其他常见秘密字段；更新动作会核验目标精确版本和最终兼容状态；非法的非数组 group config 不再保留幽灵子 entry，中文帮助恢复完整翻译。
- 删除前检查直接依赖、核心 bundle、lockfile、手工 mount、dangling patch 和 client 依赖者，保存诊断快照与隔离 overlay；删除后重新核验 dependency、bundle 与活跃 entry，并输出原版本回滚命令。
- 新增 `baseline create/compare`，保存升级前插件、Harness、配置树和 findings，并对升级后的版本、兼容状态与问题变化进行归因。
- 所有持久 YAML 修改继续使用 SHA-256 预检和同目录原子替换；已有文件使用时间戳备份，首次新建文件使用带创建内容哈希的删除式回滚记录；旧版 `--fix` 保持兼容，但永远不会推断插件隔离或删除。

### 安装

```sh
npm install --global @bruc3van/dsh-doctor@0.4.0
dsh-doctor diagnose
```

### 验证

- 覆盖配置来源与替换、非 latest 兼容候选、精确 name assertion、临时/持久隔离、备份、baseline 漂移与删除残留阻断。
- GitHub Actions 继续覆盖 macOS、Ubuntu 和 Windows，以及 Node.js 22.19 和 24。

## v0.1.6

### 主要更新

- 消除项目本地 DSH CLI 解析中的二次 manifest 读取，避免文件在检查期间变化时产生空值解引用。
- 完善 client bundle 静态扫描：忽略模板字符串正文，同时识别 `${...}` 表达式及嵌套模板中的静态 `require()`。
- 命令行值参数支持 `--profile=web`、`--home=/path`、`--harness-root=/path`、`--dsh-command=/path` 和 `--lang=en` 形式；以 `-` 开头的路径可以通过 `=` 安全传入。
- 对照当前 DeepSeek Harness 源码确认平台模块基线，并在源码中记录正式同步位置。
- 增加项目本地 CLI、模板表达式、两种用户目录分隔符和系统 locale 回退的回归测试。

### 安装

```sh
npm install --global @bruc3van/dsh-doctor@0.1.6
dsh-doctor
```

### 验证

- 53 项测试全部通过。
- 已覆盖模板字符串嵌套、对象花括号、字符串与注释隔离、等号参数、项目本地 CLI、`~/` 与 `~\` 路径，以及中英文系统 locale 回退。
- GitHub Actions 继续覆盖 macOS、Ubuntu 和 Windows，以及 Node.js 22.19 和 24。

## v0.1.5

### 主要更新

- 修复插件兼容性误判：声明的 Harness peer 当前版本无法完整解析时，状态改为 `unknown`，不再错误标记为 `compatible`。
- 完善 client bundle 静态扫描，支持未加 scope 的子路径 `require()`，并避免正则字面量造成误报或吞掉后续真实依赖。
- 统一命令行错误边界：`--json` 参数错误保持单一 JSON 文档，help/version 优先处理，路径参数支持 `~` 展开。
- 完善修复结果：失败后的动作标记为 `skipped`，用户取消与无可执行修复分别显示准确文案，并补齐 client bundle 更新建议的中文输出。
- 为命令型修复增加 10 分钟超时和更大的 JSON 输出缓冲区，避免网络命令无限挂起或因正常输出较多而失败。
- 修正中英文文档中的 DSH CLI 实际查找顺序，并补充 `DSH_DOCTOR_DSH_COMMAND` 和兼容性未知状态说明。

### 安装

```sh
npm install --global @bruc3van/dsh-doctor@0.1.5
dsh-doctor
```

### 验证

- 48 项测试全部通过。
- 已覆盖 peer 版本无法解析、子路径 require、正则字面量、JSON 参数错误、取消修复、超时与中文建议等回归场景。
- GitHub Actions 继续覆盖 macOS、Ubuntu 和 Windows，以及 Node.js 22.19 和 24。

## v0.1.4

### 主要更新

- 诊断报告改为以插件为中心，按不兼容、风险和未知状态归类，集中展示每个插件的版本、问题、证据、处理建议与可执行命令。
- 合并同一插件的多条问题并去重重复的更新建议和命令；profile 残留包统一归入独立的 DSH 环境问题。
- 优化插件兼容范围证据，将相同的插件要求与当前 DSH 版本合并展示，同时在 JSON 中保留全部原始诊断与结构化详情。
- 将容易误解的“当前 Harness 源码”统一改为“当前使用的 DSH”，并优化中英文用户文案。
- 在文本诊断末尾增加项目来源、免责声明以及 GitHub Star 和问题反馈入口。
- 更新中英文项目介绍和 npm 描述，更明确地面向 DSH 与插件使用者。

### 安装

```sh
npm install --global @bruc3van/dsh-doctor@0.1.4
dsh-doctor
```

### 验证

- 43 项测试全部通过。
- 已验证 Node.js 22.19 和 24。
- JSON 报告仍保留稳定诊断码和逐条 findings，不受文本分组与语言变化影响。

## v0.1.3

### 主要更新

- 增加 DSH 升级后的插件兼容性诊断，将插件分为兼容、未知、风险和不兼容四种状态。
- 检查所有 profile 直接插件的 Harness 对等依赖范围、已删除的 DSH 包、Node.js 版本和安装漂移，不再局限于前端插件。
- 交叉验证 profile manifest、`pnpm-lock.yaml` 和实际安装版本，并检查 DSH CLI 与 Harness 版本是否一致。
- 按 Harness 的正式算法静态组合 bundle、profile 和 home patch，在不加载插件的前提下识别无效 target、group insert 和 name assertion。
- 修复 JSON 修复模式的输出边界：子命令输出进入结构化结果，stdout 始终保持为单一合法 JSON 文档。
- 支持根据命令参数、DSH 设置和系统 locale 自适应输出中文或英文诊断结果。
- 增加中英文 README，中文继续作为默认入口。

### 安装

```sh
npm install --global @bruc3van/dsh-doctor@0.1.3
dsh-doctor
```

### 验证

- 40 项测试全部通过。
- GitHub Actions 覆盖 macOS、Ubuntu 和 Windows，以及 Node.js 22.19 和 24。
- npm 发布使用 GitHub Actions OIDC 与 provenance，不保存长期 npm token。
