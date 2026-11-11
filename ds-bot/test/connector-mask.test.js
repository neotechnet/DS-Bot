import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const PREFIX = 'mcp__notion__'
const MANY = Array.from({ length: 300 }, (_, index) => `${PREFIX}tool_${index}`)

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

// Every restrict() call is recorded per Session; one whose deny list holds throwOn
// throws, as dsh does for a name in the Agent's own scope.
async function setup({ served = ['read', ...MANY], throwOn } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-connector-mask-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext({})
  const agents = new Map()
  const calls = []
  const created = agent => Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  const agentFor = async (id) => {
    if (agents.has(id)) return agents.get(id)
    const agent = {
      id,
      session: { id },
      ctx: {
        tools: {
          register: () => () => {},
          restrict: (filter) => {
            if (throwOn !== undefined && filter.deny.includes(throwOn)) throw new Error(`"${throwOn}" is registered in this scope`)
            calls.push([id, [...filter.deny]])
            return () => {}
          },
        },
        on: () => () => {},
        effect: execute => execute(),
      },
      followup: () => {},
    }
    agents.set(id, agent)
    await created(agent)
    return agent
  }
  ctx.tools.schemas = () => served.map(name => ({ name }))
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'new' }), resolveAgent: async id => ({ agent: await agentFor(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  // The Writer has the Notion connector switched off; the Chief has nothing off.
  rt.connectorOffFor = botId => (botId === 'writer' ? [PREFIX] : [])
  const connectorCalls = id => calls.filter(([sessionId, deny]) => sessionId === id && deny.some(name => name.startsWith(PREFIX)))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, agentFor, connectorCalls, stop }
}

test('an off connector with hundreds of tools is masked in one restrict() call', async (t) => {
  const { agentFor, connectorCalls, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  await agentFor('chief')
  const writer = connectorCalls('writer')
  assert.equal(writer.length, 1)
  assert.deepEqual(new Set(writer[0][1]), new Set(MANY))
  assert.deepEqual(connectorCalls('chief'), [])
})

test('a refused batch falls back to one name at a time and masks every other name', async (t) => {
  const { agentFor, connectorCalls, stop } = await setup({ throwOn: MANY[7] })
  t.after(stop)
  await agentFor('writer')
  const masked = connectorCalls('writer').map(([, deny]) => deny)
  assert.ok(masked.every(deny => deny.length === 1))
  assert.deepEqual(new Set(masked.flat()), new Set(MANY.filter(name => name !== MANY[7])))
})

test('re-applying with the same off tools makes no new restrict() call', async (t) => {
  const { rt, agentFor, connectorCalls, stop } = await setup()
  t.after(stop)
  await agentFor('writer')
  rt.reapplyToolMasks()
  rt.reapplyToolMasks()
  assert.equal(connectorCalls('writer').length, 1)
})
