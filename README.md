# DSH Doctor

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
- `dsh.client` 的 `platform`、`immediately`、`inject`、`external` 和 `./client` export contract
- client bundle 中字面量 `require()` 与 external/module supplier 的一致性
- 已删除的 Harness client package 引用
- 第三方插件 peer range 与当前 Harness 实际版本的兼容性
- Harness installation 优先于 profile 同名 bundle 的真实解析顺序

## 修复安全边界

每条可执行修复都包含稳定 ID、风险级别、说明和精确目标：

- 文件修复在确认前展示路径，确认后再次校验 SHA-256 指纹。
- 写入前创建 `.dsh-doctor-<timestamp>.bak` 备份，再通过同目录临时文件原子替换。
- 外部命令使用固定 argv 调用，不拼接 shell 命令。
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
- 配置检查覆盖语法和 Doctor 能稳定对齐的结构，但不执行 `!!js`，也不启动第三方插件。
- 版本兼容以插件 `peerDependencies` 和当前可解析 Harness package 版本为依据；未声明兼容范围的插件只能做结构检查。
- 真实启动探针尚未默认启用，因为启动第三方插件可能产生网络、进程或持久化副作用。优先使用只读配置组合检查。

## 从源码开发

```sh
npm install
npm run check
node src/cli.mjs --help
```

新包需要先由 `@bruc3van` 对应的 npm 账号完成一次 `npm publish --access public`，创建公开包页面。然后在 npm 包设置中添加 GitHub Actions Trusted Publisher：Organization or user 为 `bruc3van`，Repository 为 `dsh-doctor`，Workflow filename 为 `release.yml`，Environment 留空，Allowed actions 只启用 `npm publish`。后续推送与 `package.json` 版本一致的 `vX.Y.Z` tag，workflow 会通过 OIDC 发布并由 npm 自动生成 provenance，不需要保存长期 npm token。
