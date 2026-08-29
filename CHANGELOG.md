# 更新日志

每个发布版本都必须在这里提供中文说明。GitHub Actions 会根据 tag 提取对应条目，自动创建或更新 GitHub Release；缺少条目或条目不包含中文时，发布流程会失败。

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
