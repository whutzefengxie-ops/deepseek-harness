/** Locale bundles for the plugin configuration section and its plugin cards. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'configurableTab' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber' | 'invalidValue'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'reviewerTitle' | 'reviewerDescription'
  | 'reviewerEnabled' | 'reviewerEnabledHint' | 'reviewerEnabledOn' | 'reviewerEnabledOff'
  | 'reviewerModel' | 'reviewerModelHint' | 'reviewerModelPlaceholder' | 'reviewerModelInvalid'
  | 'reviewerThinkingEffort' | 'reviewerThinkingEffortHint'
  | 'reviewerSandbox' | 'reviewerSandboxHint'
  | 'reviewerPrompt' | 'reviewerPromptHint'
  | 'reviewerContext' | 'reviewerContextHint'
  | 'reviewerSelectPlaceholder'
  | 'reviewerEffortLow' | 'reviewerEffortMedium' | 'reviewerEffortHigh'
  | 'reviewerSandboxReadOnly' | 'reviewerSandboxWorkspaceWrite' | 'reviewerSandboxFullAccess'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'Configure and inspect the plugins installed in this deployment.',
  tabs: 'Plugin views',
  configurableTab: 'Plugin configuration',
  empty: 'This deployment exposes no plugin settings.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  invalidValue: 'Choose a valid value, or leave blank to use the default.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'The DeepSeek search provider.',
  webSearchApiKey: 'API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'Endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
  reviewerTitle: 'Reviewer',
  reviewerDescription: 'Reviews the agent output in this conversation with the local Codex CLI.',
  reviewerEnabled: 'Enable reviewer',
  reviewerEnabledHint: 'When off, the /review command refuses to run.',
  reviewerEnabledOn: 'Enabled',
  reviewerEnabledOff: 'Disabled',
  reviewerModel: 'Codex model',
  reviewerModelHint: 'The model passed to codex exec. Use only letters, digits, ._:/@+-, or leave blank for the Codex default.',
  reviewerModelPlaceholder: 'Codex default model',
  reviewerModelInvalid: 'Use only letters, digits, ._:/@+-, or leave blank for the Codex default.',
  reviewerThinkingEffort: 'Thinking effort',
  reviewerThinkingEffortHint: 'The reasoning effort Codex uses when producing the review.',
  reviewerSandbox: 'Sandbox',
  reviewerSandboxHint: 'Prefer read-only. Writable modes let the review run transcript-driven commands with those permissions.',
  reviewerPrompt: 'Review prompt',
  reviewerPromptHint: 'Review instructions. {transcript} is replaced by the conversation; without it the conversation is appended.',
  reviewerContext: 'Scenario context',
  reviewerContextHint: 'Extra context appended to the prompt for specific scenarios. Leave blank to append none.',
  reviewerSelectPlaceholder: 'Use the default',
  reviewerEffortLow: 'Low',
  reviewerEffortMedium: 'Medium',
  reviewerEffortHigh: 'High',
  reviewerSandboxReadOnly: 'Read-only',
  reviewerSandboxWorkspaceWrite: 'Workspace write',
  reviewerSandboxFullAccess: 'Full access',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '插件',
  title: '插件',
  intro: '配置和查看本部署已安装的插件。',
  tabs: '插件视图',
  configurableTab: '插件配置',
  empty: '本部署没有开放任何插件设置。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  invalidValue: '请选择有效值；留空表示使用默认值。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  webSearchTitle: '网页搜索',
  webSearchDescription: 'DeepSeek 搜索提供方。',
  webSearchApiKey: 'API Key',
  webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchApiKeySet: '已配置密钥。',
  webSearchApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
  webSearchBaseUrl: '接口地址',
  webSearchBaseUrlHint: '留空则使用提供方默认地址。',
  webSearchMaxUses: '单次请求最多搜索次数',
  webSearchMaxUsesHint: '一次请求在必须作答前最多可以搜索多少次。',
  reviewerTitle: '审查者',
  reviewerDescription: '使用本地 Codex CLI 审查当前会话中 agent 的输出。',
  reviewerEnabled: '启用审查者',
  reviewerEnabledHint: '关闭后，/review 命令会拒绝执行。',
  reviewerEnabledOn: '已启用',
  reviewerEnabledOff: '已停用',
  reviewerModel: 'Codex 模型',
  reviewerModelHint: '传给 codex exec 的模型标识符，仅可包含字母、数字和 ._:/@+-；留空使用 Codex 默认模型。',
  reviewerModelPlaceholder: 'Codex 默认模型',
  reviewerModelInvalid: '仅可使用字母、数字和 ._:/@+-；留空表示使用 Codex 默认模型。',
  reviewerThinkingEffort: '思考程度',
  reviewerThinkingEffortHint: 'Codex 生成审查时的推理投入程度。',
  reviewerSandbox: '沙箱',
  reviewerSandboxHint: '建议使用只读模式。可写模式会让审查以相应权限执行对话记录驱动的命令。',
  reviewerPrompt: '审查提示词',
  reviewerPromptHint: '审查指令；{transcript} 会被替换为对话记录，不含占位符时对话记录追加在末尾。',
  reviewerContext: '场景上下文',
  reviewerContextHint: '针对特定场景追加到提示词的补充信息，留空不追加。',
  reviewerSelectPlaceholder: '使用默认值',
  reviewerEffortLow: '低',
  reviewerEffortMedium: '中',
  reviewerEffortHigh: '高',
  reviewerSandboxReadOnly: '只读',
  reviewerSandboxWorkspaceWrite: '工作区可写',
  reviewerSandboxFullAccess: '完全访问',
}
