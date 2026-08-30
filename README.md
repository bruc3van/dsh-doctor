# DSH Doctor

中文 | [English](README.en.md)

DSH Doctor 是面向 DSH 升级事故的诊断与恢复决策工具。它按插件回答：哪里不兼容、哪层配置造成或放大问题、首选修复是什么，以及暂时修不好时能否安全隔离或删除。

这是社区维护的第三方工具，不属于 DeepSeek 官方项目。普通诊断完全只读，也不会加载或执行待检查插件的代码。

## 安装

需要 Node.js `22.19+` 或 `24+`：

```sh
npm install --global @bruc3van/dsh-doctor
dsh-doctor diagnose
```

也可以临时运行：

```sh
npx @bruc3van/dsh-doctor diagnose
```

默认检查 `$DSH_HOME/profiles/web`；未设置 `DSH_HOME` 时使用 `~/.dsh`。特殊安装可用 `--dsh-command /path/to/dsh` 指定实际 CLI，源码工作区可用 `--harness-root /path/to/deepseek-harness`。

---

## 插件迁移：0.1.1 → 0.1.2

### migrate 命令

Doctor 内置 `dsh-v0.1.1-rc.2 → dsh-v0.1.2-alpha.2` 的版本化迁移目录，并把升级拆成三个可审计阶段：

```sh
# 阶段 1：只读分析源码、类型导入、manifest、client graph 与构建产物
dsh-doctor migrate analyze /path/to/plugin \
  --from dsh-v0.1.1-rc.2 \
  --to dsh-v0.1.2-alpha.2 \
  --harness-root /path/to/deepseek-harness

# 阶段 2：预览精确改写；加 --yes 才写入并创建时间戳备份
dsh-doctor migrate apply /path/to/plugin --safe \
  --harness-root /path/to/deepseek-harness
dsh-doctor migrate apply /path/to/plugin --safe --yes \
  --harness-root /path/to/deepseek-harness

# 阶段 3：依次完成静态、构建和隔离运行时验证
dsh-doctor migrate verify /path/to/plugin --level static \
  --harness-root /path/to/deepseek-harness
dsh-doctor migrate verify /path/to/plugin --level build --yes \
  --harness-root /path/to/deepseek-harness
dsh-doctor migrate verify /path/to/plugin --level runtime --yes \
  --harness-root /path/to/deepseek-harness
```

可用 `dsh-doctor migrations list` 确认当前 CLI 包含所需版本对；如未安装，`npx --package=@bruc3van/dsh-doctor dsh-doctor migrations list` 也可完成确认。

### 各阶段说明

**analyze**：使用 TypeScript AST 扫描，能识别不会出现在 JavaScript bundle 中的 `import type`；同时检查 package 元数据、client graph 声明和构建产物，不因 bundle 干净就推断兼容。

**apply --safe**：只迁移 catalog 标记为精确等价的符号，将非移除的 DSH 开发依赖固定到目标版本，并创建时间戳备份。可能补充精确符号迁移所需的新依赖，但不会自动修改已有 peer 范围。Session、Workspace、Conversation 和 pending interaction 属于所有权及生命周期变化，保留为 `MIG_SEMANTIC_API_CHANGE`，不做机械替换。

**verify**：

| 级别 | 执行内容 |
|---|---|
| `static` | 使用 TypeScript AST 检查源码/import、manifest、client graph 与构建产物，不执行项目脚本 |
| `build` | 执行插件构建脚本，验证产物（需 `build` 或 `pack:check` 成功；仅有 `test`/`typecheck` 不足以证明发布产物） |
| `runtime` | 打真实 tarball，在临时 `DSH_HOME` 中通过目标 CLI 安装到全新 web profile，核验 CLI 版本、profile manifest、已安装包、bundle 激活与有效配置，执行激活 smoke；不触碰普通用户的 `~/.dsh` |

最高状态为 `analyzed` → `source-migrated` → `artifact-verified` → `runtime-verified`。`runtime-verified` 仍不能替代真实 UI、生命周期与业务行为的验证。失败现场会保留并报告路径；成功后默认清理。

### 主要 API 变化

`@deepseek-ai/dsh-client-runtime` 已移除，**没有聚合替代包**，各能力迁往：

| 原能力 | 0.1.2 归属 | 迁移方式 |
|---|---|---|
| store 引擎与 equality helpers | `dsh-client-store` | 精确（catalog 已列举符号） |
| Cordis 客户端 context 类型 | `@deepseek-ai/cordis` `Context` | 精确；保留本地别名 |
| session 控制/列表/命令 | `dsh-api-session-controller/client` | 语义（需开发者判断） |
| workspace 状态/命令 | `dsh-api-workspace-controller/client` | 语义 |
| conversation 组装 | `dsh-client-ui-conversation/client` | 语义 |
| pending interaction 状态 | ui-session 聚合的各 UI 包 | 语义 |

`@deepseek-ai/dsh-host-apiproxy` 也已移除，无兼容替代，浏览器操作改用 API Remotes/API Gateway 原生 Remote 所有者。

### dsh-plugin-upgrade skill

包内同时提供 [`dsh-plugin-upgrade` skill](skills/dsh-plugin-upgrade/SKILL.md)，供编码 Agent（如 Claude Code）驱动完整迁移流程，确保不折叠任何安全阶段门控。Skill 描述触发条件：插件开发者寻求迁移、兼容性评估、API 替换、peer 依赖更新、产物重建或 DSH 0.1.2 运行时验证。

可直接从 GitHub 仓库安装到本机支持的编码 Agent：

```sh
npx skills add bruc3van/dsh-doctor
```

仓库当前只提供一个 skill，`skills` CLI 会发现并安装 `dsh-plugin-upgrade`；需要显式选择时可加 `--skill dsh-plugin-upgrade`。该命令只安装 Agent skill，不会全局安装 DSH Doctor CLI。Skill 会检查本地 CLI 版本和目标 catalog，通过只读 `npm view` 检查 registry 更新；本地 CLI 缺失、过期或缺少 catalog 时，默认固定一个精确版本并通过 `npx` 完成三阶段。全局安装或更新始终需要用户明确授权。

---

## 诊断

### 诊断模型

`diagnose` 从空树开始，按当前 DSH 的正式顺序组合配置：

```text
bundle layers → profile cordis.patch.yml → home cordis.patch.yml → CLI overlays
```

JSON 同时保留 `currentDefaultTree`、`currentEffectiveTree`、字段级来源、被替换来源和 `config` 整体替换时丢失的字段路径。重点识别：

- 旧 patch、缺失 target、错误 name assertion；
- 重复 entry id、重复插件 mount；
- 高层禁用、结构替换、group/config 整体覆盖；
- bundle 声明与 profile 激活状态冲突；
- 插件版本、产物、client contract、依赖与运行环境问题。

每个 `pluginDiagnoses[]` 都把当前 `status` 与可选 `recovery` 分开。插件即使能够隔离或删除，也不会因此被标记为已经兼容。

```sh
dsh-doctor diagnose
dsh-doctor diagnose --json
dsh-doctor diagnose --check-updates
```

只有 `--check-updates` 和 `recover` 会访问 npm registry。离线诊断只报告 `update.status: "not-checked"`，绝不会把"未检查"写成"没有兼容版本"。

---

## 恢复决策

### 兼容版本检查

Doctor 会检查所有已发布版本的 manifest，而不是只看 `latest`，并选出声明兼容当前可解析 DSH package 版本的最高版本。结论仅表示"manifest 声明兼容的候选版本"，不代表已经通过真实启动或 UI 验证。

```sh
dsh-doctor recover @scope/plugin --action check-update
dsh-doctor recover @scope/plugin --action update       # 只预览
dsh-doctor recover @scope/plugin --action update --yes # 执行精确版本
```

### 临时与持久隔离

没有兼容版本时，默认先生成临时 overlay，再用实际 profile 验证其余功能：

```sh
dsh-doctor recover @scope/plugin --action quarantine
dsh-doctor recover @scope/plugin --action quarantine --output ./plugin-quarantine.yml
dsh --profile web --patch ./plugin-quarantine.yml
```

只有所有活跃 entry 均能精确定位、都有唯一非空 id、name assertion 明确，且 bundle 没有改写其他来源 entry 时，Doctor 才会生成 overlay。核心 bundle、存在 client 依赖者或静态检测到提供运行时 Service 但无法证明依赖关系的插件都要求人工审查。overlay 会禁用插件所有已知活跃 entry，使 host 与 client 来源同时退出组合。

验证完成后才可持久化：

```sh
# 先预览精确差异
dsh-doctor recover @scope/plugin --action persist-quarantine --verified

# 明确确认后写入 profile/cordis.patch.yml
dsh-doctor recover @scope/plugin --action persist-quarantine --verified --yes
```

持久写入会追加 profile 层最终生效的禁用覆盖；如果 home 或 CLI overlay 等更高层仍会覆盖它，Doctor 会在写入前拒绝。写入后重新组合配置并逐个验证目标 entry 确实处于 disabled 状态；验证失败会返回非零退出码。写入前重新校验 SHA-256 并原子替换文件。已有 patch 会创建 `.dsh-doctor-<timestamp>.bak`；首次新建 patch 会创建 `.rollback.json`，其中记录目标文件和创建内容哈希，以便只在文件未被再次修改时执行删除式回滚。

可先预览并显式恢复备份或回滚记录：

```sh
dsh-doctor recover @scope/plugin --action rollback-quarantine \
  --backup /path/to/cordis.patch.yml.dsh-doctor-...bak
dsh-doctor recover @scope/plugin --action rollback-quarantine \
  --backup /path/to/cordis.patch.yml.dsh-doctor-...bak --yes
```

Doctor 只接受属于当前 profile patch 的时间戳恢复文件。

### 安全删除

删除是独立动作，永远不会由通用 `--fix --yes` 推断：

```sh
dsh-doctor recover @scope/plugin --action remove       # 只做影响预检
dsh-doctor recover @scope/plugin --action remove --yes # 显式执行
```

自动删除要求插件是 profile 直接依赖、不是模板/内置核心 bundle、lockfile 可读、没有会残留的手工 mount 或 dangling patch，并且当前 DSH CLI 可用。执行前会保存已脱敏的诊断快照和临时 quarantine overlay，再调用官方命令：

```sh
dsh plugin --profile web remove @scope/plugin
```

成功后重新诊断并分别验证 dependency、bundle layer 和活跃 entry 已消失，同时保留原版本的精确回滚安装命令。静态检查无法证明不存在动态 Service 依赖、外部数据残留或所有真实业务流程都正常；完成后仍须重启 profile 并验证主要功能。

---

## 历史基线

升级前保存基线，升级后比较插件版本、兼容状态、Harness 与 finding 变化：

```sh
dsh-doctor baseline create
dsh-doctor baseline compare

# 自定义基线路径
dsh-doctor baseline create --output ./before-upgrade.json
dsh-doctor baseline compare --output ./before-upgrade.json
```

默认基线位于 profile 的 `.dsh-doctor/baseline.json`。基线用于差异归因，不是当前诊断的前提，也不会覆盖当前现场证据。

## 旧版确认式修复

`--fix` / `--repair` 继续兼容 0.1.x 的确定性 install、update 与 bundle manifest 修复，不会触发 quarantine、持久化隔离或删除。文件动作展示路径并创建备份，命令使用固定 argv、绑定当前 `DSH_HOME`，任一步失败都会停止后续动作。

```sh
dsh-doctor --fix
dsh-doctor --fix --yes --json
```

---

## 输出与退出码

文本支持中文和英文，优先级为 `--lang`、`DSH_DOCTOR_LANG`、DSH 设置和系统 locale。`--json` 始终保留稳定英文 code 和完整的非秘密证据；插件 `config` 值和其他常见秘密字段会替换为 `[REDACTED]`。

| 退出码 | 含义 |
|---|---|
| `0` | 没有阻断错误，或显式动作成功且静态验证通过 |
| `1` | 仍有可能阻断启动的问题，或恢复后静态状态不完整 |
| `2` | 参数、运行环境或动作执行失败 |

## 安全边界

- 不执行第三方插件，不求值 `!!js`；诊断会解析配置结构，但 JSON、baseline 和恢复快照会脱敏所有插件 `config` 值及其他常见秘密字段，文本报告也不打印配置值；
- registry 结果只证明 manifest 声明，不证明真实运行兼容；
- 动态 Service 依赖、外部副作用、真实 UI 和业务流程需要用户验证；
- patch 精确编辑只处理 Doctor 能安全解析和定位的结构；有歧义时拒绝自动操作；
- 添加、更新或删除 bundle 后，运行中的 profile 不会自动改变 bundle 集合，必须重启。

## 从源码开发

```sh
npm install
npm run check
npm pack --dry-run
```

发布仍使用 GitHub Actions OIDC 与 npm provenance；本地实现和验证不会自动提交、打 tag 或发布。
