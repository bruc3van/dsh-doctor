# DSH Doctor

中文 | [English](README.en.md)

DSH Doctor 是给 DSH 插件开发者和 Agent 使用的升级、排障工具。它能找出插件升级时需要修改的地方，自动处理可以确定的改动，并继续检查依赖、构建产物和实际安装运行情况。

遇到需要理解业务逻辑的改动，它会明确列出来交给 Agent 或开发者处理，不会直接猜。所有修改都会先生成预览并保留备份，运行验证也会放在临时 DSH 环境中，不影响日常使用的 profile。

> 这是社区维护的第三方工具，不属于 DeepSeek 官方项目。当前迁移范围是 DSH 0.1.1 → 0.1.2；catalog 精确覆盖 `dsh-v0.1.1-rc.2` → `dsh-v0.1.2-alpha.3`，并保留 alpha.2 历史规则。未收录的版本差异仍需单独调查，不能视为 catalog 已证明兼容。

## 它能解决什么问题

| 场景 | DSH Doctor 提供的能力 |
|---|---|
| 升级插件 | 扫描源码、依赖、manifest、client graph、patch 和构建产物；自动处理 catalog 确认的精确迁移，并把语义变化交给 Agent |
| 验证迁移结果 | 依次完成静态复核、依赖同步、构建/测试、真实 tarball 打包，以及临时 profile 安装与激活验证 |
| 诊断 DSH 环境 | 检查 profile 配置层、插件版本与 peer、lockfile、bundle、patch、client contract、重复 mount 和 DSH CLI/Harness 版本漂移 |
| 安全恢复 | 比较升级前后 baseline，检查兼容更新，生成和验证隔离 overlay，并在删除前给出依赖与配置影响证据 |

这些能力既可以由 Agent 通过 Skill 编排，也可以作为结构化 CLI 能力集成到其他工具中。

## 推荐方式：让 Agent 使用 Skill

安装仓库中的 [`dsh-plugin-upgrade`](skills/dsh-plugin-upgrade/SKILL.md) Skill：

```sh
npx skills add bruc3van/dsh-doctor
```

然后在插件仓库中告诉 Agent：

```text
请把当前插件从 DSH 0.1.1 升级到 DSH 0.1.2。
先分析兼容问题，再修改代码，最后完成构建和运行时验证。
```

Skill 会引导 Agent：

1. 核实插件、实际 DSH、Harness checkout、包管理器和可用的 DSH Doctor；
2. 分析源码、依赖、配置、patch 和已有产物；
3. 确认升级后的同一插件版本是仅支持 0.1.2，还是继续兼容 0.1.1；
4. 预览并应用符合兼容策略的精确修改，再处理需要理解业务的语义迁移；
5. 重新构建，并分别报告静态、产物、隔离运行时和业务行为证据；
6. 仅在开发者明确要求后，按插件仓库自己的流程提交和发布。

`npx skills add` 只安装 Agent 指令，不会全局安装 DSH Doctor。Skill 会先检查本地 CLI 和 npm registry；本地版本不合适时，默认通过固定版本的 `npm exec` 运行，不会自行修改全局安装。

升级请求本身不代表可以放弃旧版。兼容目标未明确时，Skill 可以先做只读分析，但会在迁移写入、依赖安装、构建或运行时命令前要求确认。双版本模式必须分别验证 0.1.1 和 0.1.2，不能用一次 0.1.2 smoke 代替双版本结论。

## 工作原理

DSH Doctor 由三个相互约束的部分组成：

- **Skill**：为 Agent 定义调查步骤、兼容决策、确认门和报告标准；
- **CLI**：提供只读分析、安全修改、诊断、基线、恢复和分级验证能力；
- **Migration catalog**：保存精确 DSH tag/commit 以及已确认的 package、symbol、Service、配置和行为变化。

插件迁移流程是：

```text
调查实际环境
  → catalog 驱动分析
  → reviewed plan 精确修改
  → Agent 处理语义变化
  → 构建与产物验证
  → 临时 profile 安装和激活
  → 插件业务行为验证
```

DSH 0.1.2 不只是包版本变化。`dsh-client-runtime` 和 `dsh-host-apiproxy` 等旧 owner 被拆分，Session、Workspace、Conversation、pending interaction、Settings 等能力迁移到新的 controller、UI 包或 Service。CLI 只自动修改 catalog 标记为 `exact` 的关系；所有权、生命周期和业务调用变化会作为 `MIG_SEMANTIC_API_CHANGE` 报告。

如果提供精确 Harness checkout，Doctor 还会确认 catalog 中两个 tag 的 commit，并比较目标 web profile 的 entry id。`--target-version` 可以在完成额外源码调查后绑定更新的 0.1.2 依赖与 runtime 目标，但不会扩大 catalog 的 API 结论。

## 核心能力

| 检查内容 | 处理方式 |
|---|---|
| JS/TS import 与 named re-export | 使用 TypeScript AST 分析 type-only、别名和混合 import；仅改写已知等价 symbol |
| 移除或保留包中的 API 变化 | 检查源码和 manifest；保留仍存在的导出，并报告需要语义迁移的 symbol |
| DSH/Cordis 版本范围 | 检查 dependencies、devDependencies、peerDependencies 和实际解析版本；不自动扩大已有 peer 范围 |
| `dsh.client` 与 client export | 检查 inject、external、platform、immediately 和 `exports["./client"]` |
| Harness patch target | 在精确 Harness checkout 下比较新旧 bundle entry |
| 构建产物 | 扫描 `lib`、`dist`、`build`、`out`，识别源码与发布产物漂移 |
| 插件构建 | 运行已有 typecheck、build、test、pack:check；只有 test/typecheck 不足以证明产物已验证 |
| 安装和激活 | 打包真实 tarball，在临时 `DSH_HOME` 的新 web profile 中安装并检查生效配置 |
| Profile 诊断 | 按 DSH 顺序组合 bundle、profile、home 和 CLI overlay，保留字段来源证据 |
| 更新、隔离与删除 | 先验证版本、依赖、配置层和 dependents，再生成显式操作计划；更新、持久化隔离和删除需要明确确认 |

源码没有旧字符串、编译成功、tarball 可安装和业务行为正常是不同证据等级，Doctor 不会把其中一个冒充另一个。

## 安全与证据

- `diagnose`、`migrate analyze` 和静态验证只读，不加载或执行待检查插件；
- 只有 catalog 标记为 `exact` 的迁移可以自动修改，语义变化不会机械猜测；
- `migrate apply` 使用插件目录外的 reviewed plan，绑定完整分析、实际目标版本和所有输入文件哈希；
- 写入前复核 SHA-256，输入漂移时拒绝应用，并为已有文件创建时间戳备份；
- build/runtime 必须显式确认，并在禁用 lifecycle scripts 的情况下同步和核验依赖；
- runtime 使用临时 `DSH_HOME`，不会把待验证插件安装到正常的 `~/.dsh`；
- JSON、baseline 和恢复快照会脱敏常见 secret、token、password 和 key 字段；
- 全局 CLI 安装、持久隔离、插件删除、提交和发布都不是隐式动作。

## 能力边界

- Doctor 可以指出新 API owner 和迁移原因，但不能替代对插件业务逻辑的理解；
- 保留包中的 named import 和 named re-export 可以被识别，namespace import 的属性访问仍需人工调查；
- `runtime-verified` 只证明打包、安装和基本激活，不能证明 UI、Service 生命周期和业务流程正确；
- catalog 之外的 DSH patch 或 prerelease 必须检查额外源码差异；
- 静态诊断无法确认动态 Service 依赖和插件外部数据是否可安全删除。

## CLI 快速参考

需要 Node.js `^22.19.0` 或 `>=24.0.0`。

```sh
# 全局安装
npm install --global @bruc3van/dsh-doctor

# 或运行一个固定版本，不修改全局安装
npm exec --yes --package=@bruc3van/dsh-doctor@<version> -- dsh-doctor --help
```

| 命令 | 用途 |
|---|---|
| `dsh-doctor diagnose [--json] [--check-updates]` | 诊断当前 profile 和已安装插件；普通诊断不访问网络 |
| `dsh-doctor migrations list` | 查看当前 CLI 内置的精确 migration catalog |
| `dsh-doctor migrate analyze` / `apply` / `verify` | 分析迁移、应用 reviewed plan、执行静态/构建/runtime 验证 |
| `dsh-doctor baseline create` / `compare` | 保存或比较升级前后的脱敏诊断基线 |
| `dsh-doctor recover <package> --action <action>` | 检查更新、生成/持久化/回滚隔离或执行独立删除流程 |

完整参数和确认要求请使用 `dsh-doctor --help`。迁移编排与语义调查规则位于 [`dsh-plugin-upgrade`](skills/dsh-plugin-upgrade/SKILL.md) 及其 references 中。

## 输出与退出码

文本支持中文和英文；`--json` 使用稳定英文 code，并保留脱敏后的结构化证据。

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
