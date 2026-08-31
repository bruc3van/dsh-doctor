# DSH Doctor

中文 | [English](README.en.md)

DSH Doctor 帮助 Agent 诊断和升级 DeepSeek Harness 插件：识别新旧版本之间的 API 变化，修改可以确定迁移的代码，提示需要开发者判断的语义变化，重新构建并验证插件。

当前主要面向：

```text
DSH 0.1.1 → DSH 0.1.2
```

项目同时提供 DSH profile 和插件的诊断、兼容版本检查、隔离与删除前检查。

> 这是社区维护的第三方工具，不属于 DeepSeek 官方项目。当前 catalog 以 `dsh-v0.1.1-rc.2` 和 `dsh-v0.1.2-alpha.2` 为基准记录 0.1.1 到 0.1.2 的变化；插件使用其他 patch 或预发布版本时，Agent 仍需核对实际差异。

## 使用 Skill 升级插件

安装仓库中的 [`dsh-plugin-upgrade`](skills/dsh-plugin-upgrade/SKILL.md) Skill：

```sh
npx skills add bruc3van/dsh-doctor
```

然后在插件仓库中告诉 Agent：

```text
请把当前插件从 DSH 0.1.1 升级到 DSH 0.1.2。
先分析兼容问题，再修改代码，最后完成构建和运行时验证。
```

升级请求本身不代表可以放弃旧版。若开发者没有说明，Skill 会在任何迁移写入、依赖安装、构建或运行时命令前，显式询问升级后的同一插件版本是否还要兼容 DSH 0.1.1。选择保留兼容时，Agent 会先设计双版本适配方式，并分别验证 0.1.1 和 0.1.2；不能用一次 0.1.2 验证代替双版本结论。

Skill 会提醒 Agent 按下面的顺序工作：

1. 检查插件目录、Harness checkout、包管理器和可用的 DSH Doctor；
2. 分析源码、类型导入、依赖、manifest、client graph、patch 和构建产物；
3. 确认升级后是仅支持 0.1.2，还是同一版本继续兼容 0.1.1；
4. 预览并应用可以确定等价、且符合所选兼容策略的代码修改；
5. 根据新的 API 所有者处理需要理解业务的语义迁移；
6. 重新构建插件，并依次做静态、构建和隔离运行时验证；双版本模式分别验证两端；
7. 报告兼容目标、修改内容、剩余问题、备份和实际达到的验证等级。

`npx skills add` 只安装 Agent 指令，不会安装全局 DSH Doctor。Skill 会先检查本地 CLI 和 npm registry；本地版本不合适时，默认使用固定版本的 `npx`，不会自行修改全局 npm 安装。

验证完成后，可以再让 Agent 按插件仓库原有的版本和发布流程提交、打 tag、发布。Skill 本身不会自动提交或发布。

## 工作方式

DSH Doctor 由三部分组成：

- **Skill**：告诉 Agent 升级步骤、哪些操作需要确认，以及最后应该报告什么；
- **CLI**：扫描插件、生成问题清单、修改确定性代码，并执行分级验证；
- **Migration catalog**：记录两个 DSH 版本之间已确认的包、API、Service、配置和行为变化。

完整流程是：

```text
分析问题
  → 修改确定性代码
  → Agent 处理语义变化
  → 重新构建
  → 静态验证
  → 临时 profile 安装与激活验证
  → 按插件自己的流程发布
```

CLI 只自动修改 catalog 标记为 `exact` 的迁移。Session、Workspace、Conversation、pending interaction 等所有权和生命周期变化会标记为 `MIG_SEMANTIC_API_CHANGE`，由 Agent 结合插件代码处理，不会机械替换。

## 为什么需要版本化规则

DSH 0.1.2 不只是包版本变化，一些能力被拆分到了新的所有者：

- `@deepseek-ai/dsh-client-runtime` 已移除，没有一个新的聚合包可以直接替换；
- store 能力迁移到 `dsh-client-store`；
- Session、Workspace、Conversation 和 pending interaction 分别由新的 controller 或 UI 包负责；
- `@deepseek-ai/dsh-host-apiproxy` 已移除，浏览器调用需要迁移到对应业务 Remote；
- client graph、platform external、exports 和部分 profile patch target 也发生了变化。

Migration catalog 保存 source/target tag 和 Git commit，并记录 package、symbol、Service 和配置规则。提供 `--harness-root` 时，CLI 还会确认两个 tag 对应的 commit，并比较目标 web profile 中的 entry id。这样 Agent 可以基于明确的版本差异修改代码，而不是猜测新 API。

## 覆盖范围

| 检查内容 | Doctor/Agent 如何处理 |
|---|---|
| JS/TS import，包括 `import type`、别名和混合 import | 使用 TypeScript AST 分析；确定等价的 symbol 可自动改写 |
| 移除或新增的 DSH 包 | 检查源码和 manifest；没有残留引用时更新依赖 |
| DSH/Cordis 版本范围 | 检查 dependencies、devDependencies 和 peerDependencies；不自动扩大已有 peer 范围 |
| Session、Workspace、Conversation 等语义变化 | 报告新 owner 和变化原因，由 Agent 修改业务代码 |
| `dsh.client` 和 client export | 检查 inject、external、platform、immediately 和 `exports["./client"]` |
| Harness patch target | 有精确 Harness checkout 时比较新旧 entry |
| 构建产物 | 检查 `lib`、`dist`、`build`、`out` 中是否仍包含旧 API |
| 插件构建 | 运行项目已有的 typecheck、build、test、pack:check；必须有 build 或 pack:check 才算产物已验证 |
| 安装和激活 | 打包真实 tarball，安装到临时 `DSH_HOME` 的新 web profile 中验证 |
| UI 和业务行为 | Doctor 不自动判断；需要 Agent 或开发者执行插件自己的测试 |

源码分析使用 TypeScript AST，并同时检查 manifest、client graph 和构建产物。因此，bundle 中没有旧字符串并不代表源码已经兼容，源码编译通过也不代表发布产物和运行时已经兼容。

## 安全性

- `diagnose`、`migrate analyze` 和静态验证只读，不加载或执行待检查插件；
- `migrate apply` 必须带 `--safe --plan-file`；预览只会新建插件目录外的 plan，不会覆盖已有文件，并把完整分析和所有输入文件哈希固化下来；`--yes` 只应用同一个已审阅 plan；
- 只有 `exact` 迁移会自动改代码，语义变化不会自动猜测；
- 写入前检查文件 SHA-256，预览后文件发生变化会拒绝写入；
- 修改已有文件前创建时间戳备份，并使用临时文件原子替换；
- build 和 runtime 会同步依赖并执行插件脚本，因此必须显式使用 `--yes --install`；依赖安装禁用 lifecycle scripts，并记录 lockfile 和实际解析版本证据；
- runtime 使用临时 `DSH_HOME`，不会安装到正常的 `~/.dsh`；
- JSON、baseline 和恢复快照会脱敏插件配置和常见 secret/token/password/key 字段；
- 全局 CLI 安装、持久隔离、删除插件和发布都不会由 Skill 自动执行。

## 手动使用迁移 CLI

需要 Node.js `^22.19.0` 或 `>=24.0.0`。

先确认 CLI 包含需要的迁移：

```sh
npx --yes --package=@bruc3van/dsh-doctor@0.5.5 \
  dsh-doctor migrations list
```

### 1. 分析

```sh
dsh-doctor migrate analyze /path/to/plugin \
  --from dsh-v0.1.1-rc.2 \
  --to dsh-v0.1.2-alpha.2 \
  --harness-root /path/to/deepseek-harness \
  --json
```

分析会检查源码、依赖、manifest、client graph、patch target 和已有构建产物，不执行插件代码。

### 2. 修改

```sh
# 预览
dsh-doctor migrate apply /path/to/plugin --safe \
  --plan-file /temporary/path/reviewed-migration-plan.json \
  --harness-root /path/to/deepseek-harness --json

# 确认后写入
dsh-doctor migrate apply /path/to/plugin --safe --yes \
  --plan-file /temporary/path/reviewed-migration-plan.json \
  --harness-root /path/to/deepseek-harness --json
```

Plan 必须放在插件目录外，避免被当成插件输入。Apply 会核对 plan digest、完整分析输入和每个修改的 before/after hash；源码、manifest 或其他分析输入在预览后变化时必须重新生成并审阅 plan。确定性依赖改写使用 catalog 明确的 Client/Host 与 peer/dev 策略，不再沿用旧包所在的 dependency section。每个被修改的文件都会保留备份。

### 3. 验证

```sh
dsh-doctor migrate verify /path/to/plugin --level static \
  --harness-root /path/to/deepseek-harness --json
dsh-doctor migrate verify /path/to/plugin --level build --yes --install \
  --harness-root /path/to/deepseek-harness --json
dsh-doctor migrate verify /path/to/plugin --level runtime --yes --install \
  --harness-root /path/to/deepseek-harness --json
```

| 级别 | 验证内容 |
|---|---|
| `static` | 再次检查源码、manifest、client graph、patch 和产物 |
| `build` | 先同步并核验目标依赖和 lockfile，再运行已有构建/测试脚本并重新扫描产物 |
| `runtime` | 完成依赖与构建门后，打真实 tarball，在临时 profile 中验证目标 DSH、安装包、bundle 和生效配置 |

验证状态依次是：

```text
analyzed → source-migrated → artifact-verified → runtime-verified
```

`runtime-verified` 只表示插件能够完成打包、安装和基本激活，仍不能代替真实 UI、Service 生命周期和业务流程验证。

## DSH 和已安装插件诊断

全局安装：

```sh
npm install --global @bruc3van/dsh-doctor
dsh-doctor diagnose
```

临时运行：

```sh
npx @bruc3van/dsh-doctor diagnose
```

默认检查 `$DSH_HOME/profiles/web`；未设置 `DSH_HOME` 时使用 `~/.dsh`。

```sh
dsh-doctor diagnose
dsh-doctor diagnose --json
dsh-doctor diagnose --check-updates
```

诊断按 DSH 的顺序组合配置：

```text
bundle layers → profile cordis.patch.yml → home cordis.patch.yml → CLI overlays
```

它会检查插件版本和 peer、Node engines、安装与 lockfile、bundle 与 patch、client contract、重复 mount、高层配置覆盖，以及 DSH CLI/Harness 版本漂移。普通诊断不访问网络；只有 `--check-updates` 和 recovery 操作会访问 npm registry。

## 恢复操作

```sh
# 检查和安装 manifest 声明兼容的最高版本
dsh-doctor recover @scope/plugin --action check-update
dsh-doctor recover @scope/plugin --action update
dsh-doctor recover @scope/plugin --action update --yes

# 生成临时隔离 overlay
dsh-doctor recover @scope/plugin --action quarantine \
  --output ./plugin-quarantine.yml

# 验证临时 overlay 后持久化
dsh-doctor recover @scope/plugin --action persist-quarantine --verified
dsh-doctor recover @scope/plugin --action persist-quarantine --verified --yes

# 删除始终需要单独执行
dsh-doctor recover @scope/plugin --action remove
dsh-doctor recover @scope/plugin --action remove --yes
```

Doctor 会在隔离和删除前检查 entry、配置层、直接依赖、核心 bundle、lockfile、手工 mount 和已知 client dependents。静态检查无法确认动态 Service 依赖和外部数据，操作后仍需重启 profile 并验证主要功能。

升级前后也可以保存和比较基线：

```sh
dsh-doctor baseline create
dsh-doctor baseline compare
```

## 输出与退出码

文本支持中文和英文，`--json` 使用稳定英文 code 并保留脱敏后的结构化证据。

| 退出码 | 含义 |
|---|---|
| `0` | 没有阻断错误，或操作完成并通过对应验证 |
| `1` | 仍有兼容问题、语义迁移或验证未完成 |
| `2` | 参数、运行环境或操作执行失败 |

## 开发

```sh
npm install
npm run check
npm pack --dry-run
```

测试覆盖 CLI、配置组合、诊断、脱敏、备份与写入保护、AST 迁移、构建门控、隔离运行时验证和恢复操作。CI 在 macOS、Ubuntu 和 Windows 上测试 Node.js `22.19` 与 `24`。

本地开发、Skill 和 CLI 都不会自动提交代码、创建 tag 或发布版本。
