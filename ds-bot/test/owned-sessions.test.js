// local: sidebar-coexistence. The Bot list sits in the shell's own sidebar, so the shell
// must know which Sessions the team owns to keep them out of its own sections. The
// client publishes them on window.__dshBotSessions and fires the sessions event.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { indexRoster, ownedSessionIds } from './src/client/sources.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { indexRoster } = module.exports
// The bundle runs in its own realm; copy its arrays into this one before comparing.
const ownedSessionIds = roster => [...module.exports.ownedSessionIds(roster)]

test('the owned Sessions are every Bot part, every group Session and every Agent Session', () => {
  const roster = indexRoster({
    bots: [{ id: 'chief', sessionId: 'chief-2', parts: ['chief', 'chief-2'] }, { id: 'writer' }],
    rooms: [{ id: 'ops', sessionId: 'ops-2', ownParts: ['ops', 'ops-2'], sessions: { chief: 'ops-chief', writer: 'ops-writer' } }],
    agents: [{ id: 'agent', sessions: ['plain-1'] }],
  })
  assert.deepEqual(ownedSessionIds(roster).sort(), ['chief', 'chief-2', 'ops', 'ops-2', 'ops-chief', 'ops-writer', 'plain-1', 'writer'])
  // A Session the shell opened on its own is not the team's.
  assert.equal(ownedSessionIds(roster).includes('shell-session'), false)
})

test('an empty roster owns nothing', () => {
  assert.deepEqual(ownedSessionIds(indexRoster({ bots: [], rooms: [] })), [])
})

// The installed shell listens on the legacy name and an updated one on the new name,
// so both events go out, the new one first (LE-20261103-033).
const { SESSIONS_EVENT, legacySessionsEvent, publishOwnedSessions } = await import('../src/client/sources.js')
const fakeWindow = () => {
  const seen = []
  return { seen, dispatchEvent: (event) => { seen.push([event.type, event.detail]); return true } }
}

test('owned Sessions go out on the new event and on the legacy one, in that order', () => {
  const win = fakeWindow()
  const ids = ['s1', 's2']
  publishOwnedSessions(win, ids)
  assert.equal(SESSIONS_EVENT, 'ds-bot:sessions')
  assert.equal(legacySessionsEvent, 'dsh-bot:sessions')
  assert.deepEqual(win.seen, [['ds-bot:sessions', ids], ['dsh-bot:sessions', ids]])
  assert.deepEqual(win.__dshBotSessions, ids)
})

test('clearing publishes an empty list on both events', () => {
  const win = fakeWindow()
  publishOwnedSessions(win, [])
  assert.deepEqual(win.seen, [['ds-bot:sessions', []], ['dsh-bot:sessions', []]])
  assert.deepEqual(win.__dshBotSessions, [])
})