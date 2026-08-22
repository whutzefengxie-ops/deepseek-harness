import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import ShadowMindRuntime from '@deepseek-ai/dsh-shadow-mind-runtime'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as toolShadowMind from '@deepseek-ai/dsh-tool-shadow-mind'
import ApprovalService from '@deepseek-ai/dsh-user-approval'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('installable Shadow Mind bundle', () => {
  it('activates the actual patch entries through a real Loader tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-shadow-mind-loader-'))
    const bundlePatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
    const entries = composeEntries([loadOverlayPatches('shadow-mind-test', bundlePatch)])
    expect(entries).toEqual([
      { id: 'shadow-mind-runtime', name: '@deepseek-ai/dsh-shadow-mind-runtime' },
      { id: 'tool-shadow-mind', name: '@deepseek-ai/dsh-tool-shadow-mind' },
    ])

    const globals = globalThis as unknown as {
      __dshShadowMindRuntime: typeof ShadowMindRuntime
      __dshToolShadowMind: typeof toolShadowMind
    }
    globals.__dshShadowMindRuntime = ShadowMindRuntime
    globals.__dshToolShadowMind = toolShadowMind
    const runtimeModule = join(root, 'runtime.mjs')
    const toolModule = join(root, 'tool.mjs')
    const configPath = join(root, 'cordis.yml')
    await writeFile(runtimeModule, 'export default globalThis.__dshShadowMindRuntime\n')
    await writeFile(toolModule, [
      'const plugin = globalThis.__dshToolShadowMind',
      'export const name = plugin.name',
      'export const inject = plugin.inject',
      'export const apply = plugin.apply',
      '',
    ].join('\n'))
    await writeFile(configPath, [
      '- id: shadow-mind-runtime',
      `  name: ${pathToFileURL(runtimeModule).href}`,
      '- id: tool-shadow-mind',
      `  name: ${pathToFileURL(toolModule).href}`,
      '',
    ].join('\n'))

    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(FileSettingsProvider, { dshHome: root, watch: false })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(ApprovalService, { policy: 'never' })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    expect(ctx.shadowMind).toBeInstanceOf(ShadowMindRuntime)
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'list_shadows',
      'create_shadow',
      'update_shadow',
      'enable_shadow',
      'disable_shadow',
      'delete_shadow',
      'get_shadow_config',
      'update_shadow_config',
    ])
  })
})
