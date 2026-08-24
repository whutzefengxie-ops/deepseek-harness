# @deepseek-ai/dsh-shadow-mind

[English](README.md) | 中文

概率式 Shadow Mind 编排的可安装 profile patch。其 manifest 声明 `dsh.bundle.patch`，而 `cordis.patch.yml` 依次插入 `@deepseek-ai/dsh-shadow-mind-runtime`、`@deepseek-ai/dsh-tool-shadow-mind` 和 `@deepseek-ai/dsh-client-ui-shadow-mind`。

## 安装

把已发布包安装到现有 profile：

```sh
dsh plugin --profile <profile> add @deepseek-ai/dsh-shadow-mind
```

也可以用 `pnpm pack` 生成的本地 tarball 代替包名。Profile 会记录组合包依赖，并把它追加到 `dsh.profile.bundles`；`dsh --profile <profile> --dump-config` 会显示三条插入记录。Profile 必须已经提供 agent、settings、`spawn` subagent 提供方、command、tool 与 approval，标准 base profile 均满足这些要求。

可以在 `$DSH_HOME/shadow-minds/` 下创建定义，也可以使用需要批准的管理工具或 Web 管理界面。[运行时 README](../../shadow-mind/shadow-mind-runtime/README.zh.md)负责调度、运行条件、预算、holdout 脱敏、综合、取消与配置语义；[工具 README](../../shadow-mind/tool-shadow-mind/README.zh.md)负责模型管理与批准行为；[浏览器 README](../../client/ui-shadow-mind/README.zh.md)负责受信任的用户管理与会话展示。

在 Web profile 中，可以在**设置 → 插件 → Shadow Mind**配置全局调度、Shadow Agents 和当前会话的暂停状态。同级的**插件列表**标签会显示运行时、工具和浏览器配置项是否启用及已挂载。

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
- 浏览器管理页面没有 `Alt+S` 快捷键。其专属报告卡片在无法安全读取已持久化 relay 内容时，会回退到通用上下文行。
