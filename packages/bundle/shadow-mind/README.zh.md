# @deepseek-ai/dsh-shadow-mind

[English](README.md) | 中文

概率式 Shadow Mind 编排的可安装 profile patch。其 manifest 声明 `dsh.bundle.patch`，而 `cordis.patch.yml` 先插入 `@deepseek-ai/dsh-shadow-mind-runtime`，再插入 `@deepseek-ai/dsh-tool-shadow-mind`。

## 安装

把已发布包安装到现有 profile：

```sh
dsh plugin --profile <profile> add @deepseek-ai/dsh-shadow-mind
```

也可以用 `pnpm pack` 生成的本地 tarball 代替包名。Profile 会记录组合包依赖，并把它追加到 `dsh.profile.bundles`；`dsh --profile <profile> --dump-config` 会显示两条插入记录。Profile 必须已经提供 agent、settings、`spawn` subagent 提供方、command、tool 与 approval，标准 base profile 均满足这些要求。

可以在 `$DSH_HOME/shadow-minds/` 下创建定义，也可以使用需要批准的管理工具。[运行时 README](../../shadow-mind/shadow-mind-runtime/README.zh.md)负责调度、隐私、取消与配置语义；[工具 README](../../shadow-mind/tool-shadow-mind/README.zh.md)负责管理与批准行为。

## 模型体验

### 已挂载 Shadow 行为

#### 模型看到的内容

安装组合包会使 [8 个管理工具](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shadow-mind)可见，并启用有条件的独立 Shadow child 请求与持久化 root 报告 relay。没有任何有效且已启用的定义时，运行时不会发送辅助模型请求或 relay。

#### Token 影响

挂载期间，8 个固定 schema 会增加请求 token。辅助 child 与 relay token 仍取决于定义、root 工具轮次、概率门槛、模型过滤、暂停状态和并发容量。

#### KV Cache 影响

安装或移除组合包会改变 root 工具 schema 前缀。Shadow child 请求使用独立历史；已接受 relay 会追加到 root 历史。

## 已知限制与暂缓事项

- 组合包假定目标 profile 已提供所有注入服务和名为 `spawn` 的提供方；它不会组装独立 agent profile。
- Patch 会把面向模型的管理工具与运行时一起挂载。需要自动审查但不允许模型编辑定义的部署，应通过自己的 profile patch 只挂载运行时记录。
- 组合包不提供专用 Web 客户端、键盘快捷键、状态面板或 `shadow-report` renderer。
