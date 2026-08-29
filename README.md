# DSH Doctor

DSH Doctor 是一个独立、只读的 DeepSeek Harness profile 诊断工具。它不启动目标 Cordis 插件树，因此旧插件已经导致 Web UI 无法启动时仍可运行。

## 当前 MVP 能检查什么

- profile 的 `package.json` 是否存在且可解析
- profile 依赖和 `dsh.profile.bundles` 是否已安装
- bundle 是否声明并实际携带 `dsh.bundle.patch`
- 声明了 `dsh.client` 的第三方插件是否携带 `./client` bundle
- client bundle 的静态 `require()` 是否遗漏 `dsh.client.external`
- `dsh.client.external` 是否有当前 Client 模块提供者
- 第三方插件是否仍 `inject` 当前 Harness 源码树中已经删除的包
- 第三方插件是否保留已删除 Harness 包的 peer dependency 风险

MVP 不修改 profile，不卸载插件，也不执行第三方插件代码。

## 使用

直接从源码运行：

```sh
node src/cli.mjs
```

默认检查 `$DSH_HOME/profiles/web`；未设置 `DSH_HOME` 时使用 `~/.dsh`。

常用参数：

```sh
node src/cli.mjs --profile web
node src/cli.mjs --home /path/to/.dsh --profile web
node src/cli.mjs --harness-root /path/to/deepseek-harness
node src/cli.mjs --json
```

也可以注册为本机命令：

```sh
npm link
dsh-doctor --profile web
```

退出码：

- `0`：MVP 检查没有发现阻断问题
- `1`：发现可能导致 Harness 无法启动的问题
- `2`：命令参数错误

## 对典型旧插件故障的输出

如果旧插件 bundle 仍包含：

```js
require("@deepseek-ai/dsh-client-runtime/client")
```

但未声明当前模块图需要的 external，Doctor 会报告 `UNDECLARED_CLIENT_REQUIRE`。如果插件还通过 `dsh.client.inject` 引用当前 Harness 已删除的包，也会报告 `REMOVED_CLIENT_INJECT`，并建议升级或禁用插件，而不是自动添加不安全的兼容 shim。

## MVP 限制

- 静态扫描只识别字面量 `require("package")`；动态拼接的依赖需要未来的 bundle 元数据协议支持。
- 当前平台 seed module 列表随本版本工具维护；未来应由 Harness 暴露可机读的 Doctor 协议。
- 当前版本只诊断，不提供 `--repair`、自动备份、隔离或回滚。
