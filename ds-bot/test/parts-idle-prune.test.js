// A part that crosses its check line between turns must not get a tool-result pruning pass
// there: DSH's session format accepts a tool/result replacement only inside an open turn, so
// the compaction/prune + tool/result pair written while idle leaves a stored log that can
// never load again ("tool/result replacement is outside an open turn").
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { output } from '../src/host/tools.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(15)
  }
  return predicate()
}

async function boot(t, { contextWindow, checkRatio, toolExecute, onTurn }) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-idle-prune-'))
  const root = new Context()
  await mountAgentLoopTestDependencies(root)
  await root.plugin(TokenMeter)
  await root.plugin(ToolResultPruner, {})
  await root.plugin(BasicCompactionEngine)
  const calls = []

  class Adapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'mock' } }
    async listModels() { return [{ id: 'm', name: 'm', inputModalities: ['text'] }] }
    async resolveModel(provider, id) {
      return {
        provider, id, name: id, inputModalities: ['text'],
        context: { contextWindow }, defaultMaxTokens: 4_000,
        reasoning: { defaultEffort: 'high', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
      }
    }
    async *stream(req) {
      if (req.purpose === 'compaction') {
        const steward = (req.system ?? '').includes('context steward')
        calls.push({ kind: steward ? 'steward' : 'compaction' })
        const text = steward
          ? JSON.stringify({ action: 'compact', reason: 'continue' })
          : '- Done: earlier turns summarized\n- Remaining: continue'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const step = calls.filter(c => c.kind === 'turn').length + 1
      calls.push({ kind: 'turn', step })
      const plan = onTurn(step)
      if (plan.toolCall) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call', id: plan.toolCall.id, name: plan.toolCall.name }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: plan.toolCall.id, name: plan.toolCall.name, arguments: JSON.stringify(plan.toolCall.args) } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: plan.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: plan.text } }
      }
      if (plan.usage) yield { type: 'usage', usage: plan.usage }
      yield { type: 'finish', reason: { kind: plan.toolCall ? 'tool-calls' : 'stop' } }
    }
  }

  root.llm.registerAdapter(['mock'], new Adapter())
  await mountAgentLoopTestHarness(root)
  const { agents, tools } = await new Promise(resolve => root.inject(['agents', 'tools'], resolve))
  tools.register(defineTool({
    name: 'inspect_file',
    description: 'Inspect a file path',
    parameters: { path: { type: 'string', description: 'File path to inspect' } },
    output,
    execute: async () => toolExecute(),
  }))
  let parts = 0
  root.provide('sessionTitle', { setTitle: async () => {}, rename: async () => {} })
  root.provide('workspaceRegistry', {
    archiveSession: async () => {},
    unarchiveSession: async () => {},
    resolveByPath: async () => ({ id: 'ws-1', path: home }),
    create: async () => ({ id: 'ws-1', path: home }),
    get: () => ({ id: 'ws-1', path: home }),
    list: () => [{ id: 'ws-1', path: home }],
    listAll: async () => [{ id: 'ws-1', path: home }],
  })
  root.provide('connection', { fetch: { register: () => () => {} } })
  root.provide('sessionController', {
    resolveAgent: async id => ({ agent: agents.get(id) }),
    selectModel: async () => {},
    page: async ({ address }) => ({ records: (agents.get(address.sessionId)?.session?.snapshotEvents?.() ?? []).map(event => ({ event })), hasMore: false }),
    create: async ({ cwd }) => {
      const id = `part-${++parts}`
      const created = await agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'm', maxTokens: 4_000, reasoningEffort: 'high', temperature: 0.3 }, meta: { cwd: cwd ?? home } })
      return { sessionId: id, agent: created.agent }
    },
  })
  await new Promise(resolve => root.inject(['sessionTitle', 'workspaceRegistry', 'connection', 'sessionController'], resolve))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, workspaceId: 'ws-1', mainBotIds: ['m1'], revision: 1,
    bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief', instructions: '', createdAt: 1, model: 'mock/m' } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const rt = createRuntime(root, { home, checkRatio, scheduleAttachWaitMs: 0 })
  await rt.load()
  const { agent } = await agents.create({ sessionId: 'm1', agentOptions: { provider: 'mock', model: 'm', maxTokens: 4_000, reasoningEffort: 'high', temperature: 0.3 }, meta: { cwd: home } })
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const runTurn = async text => {
    const done = new Promise(resolve => {
      const off = root.on('agent/status', ({ agent: a, status }) => {
        if (a.id === agent.id && status === 'idle') { off(); resolve() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await done
  }
  return { rt, agent, agents, calls, runTurn }
}

// Every compaction/prune and every tool/result that replaces an earlier event must sit
// between a turn/start and its turn/end, as DSH's stored-log check demands.
function replacementsOutsideTurns(events) {
  let open = false
  const outside = []
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
    else if (!open && (event.type === 'compaction/prune' || (event.type === 'tool/result' && event.surfaceOp !== undefined && event.surfaceOp !== 'append'))) {
      outside.push(`${event.type} ${event.seq}`)
    }
  }
  return outside
}

test('a part over its check line between turns gets no tool-result pruning pass while idle', async (t) => {
  const huge = 'LOG_LINE_0123456789 '.repeat(5_000) // about 25k tokens
  const { rt, agent, agents, calls, runTurn } = await boot(t, {
    contextWindow: 50_000,
    checkRatio: 0.4, // check line about 18.4k tokens
    toolExecute: () => huge,
    onTurn: step => step === 1
      ? { toolCall: { id: 'tc-idle-1', name: 'inspect_file', args: { path: 'huge.log' } }, usage: { inputTokens: 1_500, outputTokens: 100 } }
      : { text: 'TURN_DONE', usage: { inputTokens: 27_000, outputTokens: 100 } },
  })

  await runTurn('Check huge.log')
  // The idle size check runs after the turn; give it time to act (steward, compaction or switch).
  await waitFor(() => calls.some(c => c.kind === 'steward' || c.kind === 'compaction') || rt.chatOf('m1') !== 'm1', 3_000)
  await sleep(200)

  for (const id of new Set(['m1', rt.chatOf('m1')])) {
    const events = (agents.get(id) ?? agent).session.snapshotEvents()
    assert.deepEqual(replacementsOutsideTurns(events), [], `part ${id} must hold no tool-result replacement outside an open turn`)
  }
})

test('tool-result pruning inside a turn still runs and stays inside that turn', async (t) => {
  const huge = 'BUILD_OUTPUT_LINE_9876543210 '.repeat(6_000) // about 43k tokens, past the hard line
  const { agent, runTurn } = await boot(t, {
    contextWindow: 50_000,
    checkRatio: 0.4,
    toolExecute: () => huge,
    onTurn: step => step === 1
      ? { toolCall: { id: 'tc-mid-1', name: 'inspect_file', args: { path: 'build.log' } }, usage: { inputTokens: 1_500, outputTokens: 100 } }
      : { text: 'MID_TURN_DONE', usage: { inputTokens: 4_000, outputTokens: 100 } },
  })

  await runTurn('Inspect build.log')
  const events = agent.session.snapshotEvents()
  assert.equal(events.some(event => event.type === 'compaction/prune'), true, 'the mid-turn pass must still prune the oversized tool output')
  assert.deepEqual(replacementsOutsideTurns(events), [])
})
