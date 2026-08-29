# DSH Doctor

中文 | [English](README.en.md)

DSH Doctor 用来定位 DeepSeek Harness 无法启动、配置损坏和第三方插件不兼容等常见问题。默认运行完全只读；只有显式使用 `--fix`，查看精确的文件或命令计划并确认后，它才会实施可回滚的修复。

这是社区维护的第三方工具，不属于 DeepSeek 官方项目。它不会加载或执行待检查插件的代码。

## 安装

需要 Node.js `22.19+` 或 `24+`：

```sh
npm install --global @bruc3van/dsh-doctor
dsh-doctor
```

也可以临时运行：

```sh
npx @bruc3van/dsh-doctor
```

默认检查 `$DSH_HOME/profiles/web`；未设置 `DSH_HOME` 时使用 `~/.dsh`。

Doctor 不要求 `dsh` 必须是全局命令。它会按顺序查找 PATH、当前项目安装、profile 共享安装或 npx 缓存留下的链接、已构建的 Harness 源码工作区。DSH Desktop 内置运行时或其他特殊安装可以通过 `--dsh-command /path/to/dsh`（也接受官方包的 `lib/bin.js`）明确指定。找不到 CLI 时仍会完成只读诊断，但不会提供或执行无法验证的命令型修复。

## 工作方式

一次完整流程分为四步：

1. `dsh-doctor` 只读检查当前 DSH Home、profile、插件和 Harness 版本。
2. Doctor 按错误、警告和插件兼容状态展示证据与建议。
3. `dsh-doctor --fix` 先展示精确的文件修改或 DSH 命令计划，并等待用户确认。
4. 修复完成后自动重新诊断，以最终状态决定退出码。

Doctor 不会加载待检查插件，也不会在普通诊断时修改配置。无法确定正确结果的操作，例如猜测凭据、重写损坏 YAML 或直接移除插件，只会给出建议。

## 输出语言

文本输出支持中文和英文。默认依次读取：

1. `--lang zh|en`
2. `DSH_DOCTOR_LANG`
3. 当前 DSH Home 中 `settings.yaml` 的 `locale.preference`
4. 终端或系统 locale

```sh
dsh-doctor --lang zh
dsh-doctor --lang en
DSH_DOCTOR_LANG=zh dsh-doctor
```

`--json` 始终保留稳定的英文消息与诊断 code，避免语言变化破坏脚本。

## DSH 升级后的插件兼容性

DSH 更新后，Doctor 会把每个 profile 插件归入一个明确状态，并在文本与 JSON 报告中汇总：

- `incompatible`：已经发现会阻断插件加载或 Harness 启动的错误，例如插件未安装，或注入了已删除的 client runtime。
- `risk`：发现当前版本风险，例如 Harness peer range 不接受新版本、仍依赖已删除的 DSH 包、Node.js 不兼容，或安装版本发生漂移。
- `unknown`：插件没有通过 `peerDependencies` 声明 Harness 兼容范围；Doctor 无法证明它支持升级后的 DSH，但不会把未知误报成故障。
- `compatible`：插件声明的兼容范围接受当前 Harness，且没有发现插件相关错误或警告。

兼容性检查覆盖所有 profile 直接插件，不再只检查带 `dsh.client` 的前端插件；纯 bundle 或服务端插件引用旧 Harness API 也会被报告。建议 DSH 升级后先运行一次 `dsh-doctor`，再根据精确的 update 建议决定是否执行 `dsh-doctor --fix`。

## 常用命令

```sh
# 只读诊断
dsh-doctor
dsh-doctor --profile web
dsh-doctor --home /path/to/.dsh
dsh-doctor --dsh-command /path/to/@deepseek-ai/dsh/lib/bin.js

# 机器可读的只读报告，不显示提示
dsh-doctor --json

# 展示修复计划，确认后实施并重新诊断
dsh-doctor --fix

# 自动化环境中显式确认当前计划
dsh-doctor --fix --yes --json
```

`--repair` 是 `--fix` 的别名。`--yes` 只有和 `--fix` 一起使用才有效。

## 当前检查范围

- profile `package.json` 的 JSON 根结构、依赖表、bundle 列表和 reload 生命周期
- profile、home 和 bundle 的 `cordis.patch.yml` 语法与顶层结构，包括 `!!js` 表达式
- `settings.yaml` 和 `.credentials.yaml` 的安全结构检查；凭据诊断不输出秘密值
- profile 依赖、bundle 声明、patch 文件和 client bundle 是否存在
- profile `package.json`、`pnpm-lock.yaml` importer 与实际安装版本是否一致
- 所有直接插件（包括纯 bundle/服务端插件）的 Node.js `engines`、Harness peer range、旧 DSH 依赖与当前运行时是否兼容
- 当前 DSH CLI、Harness 工作区和 profile 顶层 `@deepseek-ai/dsh-*` 包是否发生版本漂移或残留
- `dsh.client` 的 `platform`、`immediately`、`inject`、`external` 和 `./client` export contract
- client bundle 中字面量 `require()` 与 external/module supplier 的一致性
- 已删除的 Harness client package 引用
- 第三方插件 peer range 与当前 Harness 实际版本的兼容性
- Harness installation 优先于 profile 同名 bundle 的真实解析顺序
- 按 Harness 官方层级顺序静态组合 bundle、profile 和 home patch，检查缺失 target、错误 group insert 与 name assertion；不会加载插件

## 修复安全边界

每条可执行修复都包含稳定 ID、风险级别、说明和精确目标：

- 文件修复在确认前展示路径，确认后再次校验 SHA-256 指纹。
- 写入前创建 `.dsh-doctor-<timestamp>.bak` 备份，再通过同目录临时文件原子替换。
- 外部命令使用固定 argv 调用，不拼接 shell 命令。
- `--json --fix --yes` 会捕获子命令输出并放入修复结果，保证 stdout 始终只有一个合法 JSON 文档。
- 命令修复绑定当前诊断的 `DSH_HOME`，并展示解析出的真实 CLI 路径；不会假定 PATH 中存在 `dsh`。
- 任一步失败即停止后续修复，并保留已经创建的备份。
- 完成后重新运行全部诊断，以最终状态决定退出码。

首期只自动处理确定性操作，例如把已安装 bundle 恢复到 manifest 列表，或运行明确的 profile install/update。损坏 JSON/YAML、凭据值和插件移除只给建议，不猜测应该删除或改成什么。

## 退出码

- `0`：没有阻断错误；warning 仍会显示
- `1`：发现可能阻断 Harness 启动的问题
- `2`：参数、运行环境或修复执行失败

## 当前限制

- 静态扫描只识别代码中的字面量 `require("package")`；动态依赖需要未来的 bundle 元数据协议。
- 配置检查覆盖语法和 Doctor 能稳定对齐的结构，并按当前 Harness patch 算法做无执行组合检查；不会求值 `!!js`，也不会加载第三方插件。
- 版本兼容以插件 `peerDependencies` 和当前可解析 Harness package 版本为依据；未声明兼容范围的插件只能做结构检查。
- lockfile 检查只对 profile 的直接依赖 importer 做确定性交叉验证，不递归扫描整个 npm 依赖树。
- 真实启动探针尚未启用；即使复制 `DSH_HOME`，第三方插件仍可能访问网络、绝对路径或启动外部进程，不能宣称无副作用。

## 从源码开发

```sh
npm install
npm run check
node src/cli.mjs --help
```

新包需要先由 `@bruc3van` 对应的 npm 账号完成一次 `npm publish --access public`，创建公开包页面。然后在 npm 包设置中添加 GitHub Actions Trusted Publisher：Organization or user 为 `bruc3van`，Repository 为 `dsh-doctor`，Workflow filename 为 `release.yml`，Environment 留空，Allowed actions 只启用 `npm publish`。

后续发布前，需要在 `CHANGELOG.md` 中增加与版本 tag 同名的中文 `## vX.Y.Z` 条目。推送与 `package.json` 版本一致的 tag 后，workflow 会通过 OIDC 发布 npm 包、生成 provenance，并自动用该中文条目创建或更新 GitHub Release；缺少中文条目时发布流程会失败。不需要保存长期 npm token。
