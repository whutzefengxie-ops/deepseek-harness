import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  buildReviewPrompt, codexReviewArgv, parseCodexJsonLine, renderTranscript, TRANSCRIPT_PLACEHOLDER,
} from '../src/codex.ts'

const PROMPT = 'Review the agent conversation.\n\nTranscript:\n{transcript}'
const TRANSCRIPT = 'User: fix the bug\nAgent: done'

/** One minimal frozen message fixture with the given role and blocks. */
function message(
  role: Message['role'],
  content: Message['content'],
  id = `m-${content[0]?.type ?? 'empty'}`,
): Message {
  return {
    id,
    role,
    content,
    source: { kind: 'user' },
  } as Message
}

describe('codexReviewArgv', () => {
  it('builds the fixed exec flags with the configured model', () => {
    expect(codexReviewArgv({ model: 'gpt-5.1-codex-mini', thinkingEffort: 'high', sandbox: 'read-only' }, 'linux')).toEqual([
      'codex', 'exec', '--json',
      '--color', 'never',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s', 'read-only',
      '-m', 'gpt-5.1-codex-mini',
      '-c', 'model_reasoning_effort=high',
    ])
  })

  it('omits the model flag when none is configured', () => {
    expect(codexReviewArgv({ model: '', thinkingEffort: 'low', sandbox: 'workspace-write' }, 'darwin')).toEqual([
      'codex', 'exec', '--json',
      '--color', 'never',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s', 'workspace-write',
      '-c', 'model_reasoning_effort=low',
    ])
  })

  it('wraps the command in cmd.exe on Windows', () => {
    expect(codexReviewArgv({ model: '', thinkingEffort: 'medium', sandbox: 'read-only' }, 'win32')).toEqual([
      'cmd.exe', '/d', '/s', '/c', 'codex', 'exec', '--json',
      '--color', 'never',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s', 'read-only',
      '-c', 'model_reasoning_effort=medium',
    ])
  })

  it.each([
    'gpt-5.1-codex-mini & whoami',
    'gpt-5.1-codex-mini|whoami',
    'gpt-5.1-codex-mini%PATH%',
    'gpt-5.1-codex-mini with-space',
  ])('rejects model text that could become shell syntax on Windows: %s', (model) => {
    expect(() => codexReviewArgv({ model, thinkingEffort: 'medium', sandbox: 'read-only' }, 'win32'))
      .toThrow('portable model identifier')
  })

  it('passes every sandbox mode through verbatim', () => {
    for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      expect(codexReviewArgv({ model: '', thinkingEffort: 'medium', sandbox }, 'linux'))
        .toContain(sandbox)
    }
  })
})

describe('parseCodexJsonLine', () => {
  it('maps turn, command, tool, search, file, message, and unknown item events', () => {
    expect(parseCodexJsonLine('{"type":"turn.started"}')).toEqual({
      activity: { activityId: 'turn', kind: 'analysis', status: 'started' },
    })
    expect(parseCodexJsonLine('{"type":"turn.completed"}')).toEqual({
      activity: { activityId: 'turn', kind: 'analysis', status: 'completed' },
    })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.started', item: { id: 'reason', type: 'reasoning' },
    }))).toEqual({ activity: {
      activityId: 'reason', kind: 'analysis', status: 'started',
    } })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.started', item: { id: 'command', type: 'command_execution', command: 'pnpm test' },
    }))).toEqual({ activity: {
      activityId: 'command', kind: 'command', status: 'started', detail: 'pnpm test',
    } })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.completed', item: { id: 'tool', type: 'mcp_tool_call', server: 'github', tool: 'search' },
    }))).toEqual({ activity: {
      activityId: 'tool', kind: 'tool', status: 'completed', detail: 'github.search',
    } })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.started', item: { id: 'tool-only', type: 'mcp_tool_call', tool: 'search' },
    }))).toEqual({ activity: {
      activityId: 'tool-only', kind: 'tool', status: 'started', detail: 'search',
    } })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.started', item: { id: 'server-only', type: 'mcp_tool_call', server: 'github' },
    }))).toEqual({ activity: {
      activityId: 'server-only', kind: 'tool', status: 'started', detail: 'github',
    } })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.started', item: { id: 'tool-unspecified', type: 'mcp_tool_call' },
    }))).toEqual({ activity: {
      activityId: 'tool-unspecified', kind: 'tool', status: 'started',
    } })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'Codex JSONL' },
    }))).toEqual({ activity: {
      activityId: 'search', kind: 'web-search', status: 'completed', detail: 'Codex JSONL',
    } })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.completed', item: { id: 'files', type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] },
    }))).toEqual({ activity: {
      activityId: 'files', kind: 'file-change', status: 'completed', detail: 'a.ts, b.ts',
    } })
    for (const item of [
      { id: 'files-missing', type: 'file_change' },
      { id: 'files-empty', type: 'file_change', changes: [] },
      { id: 'files-invalid', type: 'file_change', changes: [null, [], 1, {}, { path: '' }] },
    ]) {
      expect(parseCodexJsonLine(JSON.stringify({ type: 'item.started', item }))).toEqual({ activity: {
        activityId: item.id, kind: 'file-change', status: 'started',
      } })
    }
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'Review' },
    }))).toEqual({
      activity: { activityId: 'message', kind: 'message', status: 'completed' },
      finalText: 'Review',
    })
    expect(parseCodexJsonLine(JSON.stringify({
      type: 'item.started', item: { id: 'future', type: 'future_item' },
    }))).toEqual({ activity: {
      activityId: 'future', kind: 'other', status: 'started', detail: 'future_item',
    } })
  })

  it('maps explicit failures, ignores unknown top-level records, and rejects malformed supported records', () => {
    expect(parseCodexJsonLine('{"type":"turn.failed","error":{"message":"bad auth"}}'))
      .toEqual({ failure: 'bad auth' })
    expect(parseCodexJsonLine('{"type":"error","message":"network"}'))
      .toEqual({ failure: 'network' })
    expect(parseCodexJsonLine('{"type":"error","error":"fallback"}'))
      .toEqual({ failure: 'fallback' })
    for (const error of [null, [], {}, { message: '' }, '']) {
      expect(parseCodexJsonLine(JSON.stringify({ type: 'turn.failed', error })))
        .toEqual({ failure: 'Codex reported an unspecified error.' })
    }
    expect(parseCodexJsonLine('{"type":"thread.started","thread_id":"one"}')).toEqual({})
    expect(() => parseCodexJsonLine('{bad}')).toThrow('invalid JSON')
    expect(() => parseCodexJsonLine('null')).toThrow('Codex event must be a JSON object')
    expect(() => parseCodexJsonLine('[]')).toThrow('Codex event must be a JSON object')
    expect(() => parseCodexJsonLine('1')).toThrow('Codex event must be a JSON object')
    expect(() => parseCodexJsonLine('{}')).toThrow('Codex event type must be a non-empty string')
    expect(() => parseCodexJsonLine('{"type":""}')).toThrow('Codex event type must be a non-empty string')
    expect(() => parseCodexJsonLine('{"type":"item.started","item":null}'))
      .toThrow('item.started item must be a JSON object')
    expect(() => parseCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message"}}'))
      .toThrow('Codex item id must be a non-empty string')
    expect(() => parseCodexJsonLine('{"type":"item.completed","item":{"id":"m","type":""}}'))
      .toThrow('Codex item type must be a non-empty string')
    expect(() => parseCodexJsonLine('{"type":"item.completed","item":{"id":"m","type":"agent_message","text":""}}'))
      .toThrow('Codex agent message text must be a non-empty string')
    expect(parseCodexJsonLine('{"type":"item.started","item":{"id":"m","type":"agent_message","text":"draft"}}'))
      .toEqual({ activity: { activityId: 'm', kind: 'message', status: 'started' } })
  })

  it('omits empty optional operation details', () => {
    for (const item of [
      { id: 'command', type: 'command_execution', command: '' },
      { id: 'search', type: 'web_search', query: 1 },
    ]) {
      expect(parseCodexJsonLine(JSON.stringify({ type: 'item.started', item }))).toEqual({ activity: {
        activityId: item.id,
        kind: item.type === 'command_execution' ? 'command' : 'web-search',
        status: 'started',
      } })
    }
  })
})

describe('buildReviewPrompt', () => {
  it('substitutes the transcript at the placeholder', () => {
    expect(buildReviewPrompt(PROMPT, '', '', TRANSCRIPT)).toBe(
      `Review the agent conversation.\n\nTranscript:\n${TRANSCRIPT}`,
    )
  })

  it('appends the transcript when the prompt carries no placeholder', () => {
    expect(buildReviewPrompt('Be critical.', '', '', TRANSCRIPT))
      .toBe(`Be critical.\n\n${TRANSCRIPT}`)
  })

  it('replaces every placeholder occurrence', () => {
    const prompt = `${TRANSCRIPT_PLACEHOLDER} again: ${TRANSCRIPT_PLACEHOLDER}`
    expect(buildReviewPrompt(prompt, '', '', TRANSCRIPT))
      .toBe(`${TRANSCRIPT} again: ${TRANSCRIPT}`)
  })

  it('appends the scenario context and the focus as labelled sections', () => {
    const built = buildReviewPrompt(PROMPT, 'This is a security patch review.', 'Focus on the auth flow.', TRANSCRIPT)
    expect(built).toBe([
      `Review the agent conversation.\n\nTranscript:\n${TRANSCRIPT}`,
      '',
      'Additional review context:\nThis is a security patch review.',
      '',
      'Reviewer focus for this run:\nFocus on the auth flow.',
    ].join('\n'))
  })

  it('omits blank context and focus sections', () => {
    expect(buildReviewPrompt(PROMPT, '   ', '  ', TRANSCRIPT))
      .toBe(`Review the agent conversation.\n\nTranscript:\n${TRANSCRIPT}`)
  })

  it('appends a focus-only section', () => {
    expect(buildReviewPrompt(PROMPT, '', 'Focus on the diff.', TRANSCRIPT))
      .toBe(`Review the agent conversation.\n\nTranscript:\n${TRANSCRIPT}\n\nReviewer focus for this run:\nFocus on the diff.`)
  })

  it('appends a context to an appended transcript without duplicating separators', () => {
    expect(buildReviewPrompt('Be critical.', 'Review a patch.', '', TRANSCRIPT))
      .toBe(`Be critical.\n\n${TRANSCRIPT}\n\nAdditional review context:\nReview a patch.`)
  })
})

describe('renderTranscript', () => {
  it('renders user and assistant text with role labels', () => {
    expect(renderTranscript([
      message('user', [{ type: 'text', text: 'fix the bug' }]),
      message('assistant', [{ type: 'text', text: 'done' }], 'a'),
    ], 1_000)).toBe('User: fix the bug\nAgent: done')
  })

  it('renders tool calls and tool results', () => {
    expect(renderTranscript([
      message('assistant', [{ type: 'tool-call', id: 'c1' as never, name: 'read', arguments: '{"path":"a.ts"}' }], 'a'),
      message('user', [{
        type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
      }], 'u'),
    ], 1_000)).toBe([
      'Agent tool call: read({"path":"a.ts"})',
      'Tool result (c1): line one line two',
    ].join('\n'))
  })

  it('skips non-text children inside a tool result', () => {
    expect(renderTranscript([
      message('user', [{
        type: 'tool-result',
        toolCallId: 'c2' as never,
        content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'kept' }],
      }], 'u'),
    ], 1_000)).toBe('Tool result (c2): kept')
  })

  it('skips reasoning and image blocks', () => {
    expect(renderTranscript([
      message('assistant', [
        { type: 'reasoning', text: 'thinking out loud' },
        { type: 'text', text: 'kept' },
      ], 'a'),
      message('user', [
        {
          type: 'image',
          attachment: {
            attachmentId: 'i1' as never,
            mediaType: 'image/png',
            bytes: 3,
            width: 1,
            height: 1,
          },
        },
        { type: 'text', text: 'also kept' },
      ], 'u'),
    ], 1_000)).toBe('Agent: kept\nUser: also kept')
  })

  it('falls through unknown future block types without failing', () => {
    const unknown = { type: 'some-future-block', payload: 'x' } as never
    expect(renderTranscript([
      message('assistant', [unknown, { type: 'text', text: 'known' }], 'a'),
    ], 1_000)).toBe('Agent: known')
  })

  it('renders an empty conversation as an empty transcript', () => {
    expect(renderTranscript([], 1_000)).toBe('')
  })

  it('keeps the tail when the transcript exceeds the bound, with a header', () => {
    const body = `User: ${'a'.repeat(120)}`
    const rendered = renderTranscript([message('user', [{ type: 'text', text: 'a'.repeat(120) }])], 100)
    expect(rendered).toBe(`[Transcript truncated: showing the last 100 of ${body.length} characters.]\n${body.slice(body.length - 100)}`)
    expect(rendered.endsWith('aaa')).toBe(true)
  })

  it('keeps the full transcript exactly at the bound', () => {
    const text = 'User: abc'
    const rendered = renderTranscript([message('user', [{ type: 'text', text: 'abc' }])], text.length)
    expect(rendered).toBe(text)
  })
})
