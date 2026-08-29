# 更新日志

每个发布版本都必须在这里提供中文说明。GitHub Actions 会根据 tag 提取对应条目，自动创建或更新 GitHub Release；缺少条目或条目不包含中文时，发布流程会失败。

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
