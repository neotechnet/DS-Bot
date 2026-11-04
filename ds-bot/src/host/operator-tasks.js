// Operator tasks: per Bot, what waits on the user (Unresolved) and what the Bot is
// working on (Active). Built only from sources the host already keeps, plus the
// operator's loose-ends register, which this module reads and never writes.
// Git, CI and merges reach none of these sources, so no text filter is needed.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_REGISTER = join(homedir(), '.claude', 'state', 'loose-ends', 'register.jsonl')
// The register is polled with every state answer; a stat this often is enough.
const STAT_EVERY_MS = 2000
const TEXT_MAX = 240

const clip = (text, max = TEXT_MAX) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const timeOf = (value) => {
  const at = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : undefined
}

// The register is append-only: the newest record of an id is its current state, and
// its first record says when it was opened. Only open decisions wait on the operator.
export function openDecisions(text) {
  const latest = new Map()
  const opened = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (typeof record?.id !== 'string') continue
    if (!opened.has(record.id)) opened.set(record.id, timeOf(record.ts))
    latest.set(record.id, record)
  }
  const decisions = []
  for (const record of latest.values()) {
    if (record.state !== 'open' || record.kind !== 'decision' || typeof record.owner !== 'string') continue
    decisions.push({
      id: record.id,
      owner: record.owner,
      text: clip(record.text),
      ...(record.due ? { due: String(record.due) } : {}),
      ...(record.risk ? { risk: String(record.risk) } : {}),
      carded: Boolean(record.carded_at),
      at: opened.get(record.id) ?? timeOf(record.ts),
    })
  }
  return decisions
}

export function install(rt) {
  const { state } = rt
  const configured = rt.config?.looseEnds
  const path = configured === false ? undefined : (configured ?? process.env.DS_BOT_LOOSE_ENDS ?? DEFAULT_REGISTER)
  let cache = { key: '', decisions: [] }
  let checkedAt = 0

  const decisions = () => {
    if (path === undefined) return []
    const now = Date.now()
    if (now - checkedAt < STAT_EVERY_MS) return cache.decisions
    checkedAt = now
    let key
    try {
      const stat = statSync(path)
      key = `${stat.mtimeMs}:${stat.size}`
    } catch {
      // No register on this machine: the section is just empty.
      cache = { key: '', decisions: [] }
      return cache.decisions
    }
    if (key === cache.key) return cache.decisions
    try {
      cache = { key, decisions: openDecisions(readFileSync(path, 'utf8')) }
    } catch {
      cache = { key: '', decisions: [] }
    }
    return cache.decisions
  }

  const botOfSession = id => rt.groupOwners?.get(id)?.botId ?? rt.chatOwners?.get(id)
  const roomOfSession = id => rt.groupOwners?.get(id)?.roomId

  function operatorTasksView() {
    const view = {}
    const entryOf = (botId) => {
      if (botId === undefined || state.bots?.[botId] === undefined) return undefined
      return (view[botId] ??= { active: [], unresolved: [] })
    }
    const add = (botId, list, item) => { entryOf(botId)?.[list].push(item) }

    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      if (question === undefined || question === null) continue
      const roomId = roomOfSession(sessionId)
      add(botOfSession(sessionId), 'unresolved', { kind: 'question', key: `question:${question.id ?? sessionId}`, text: clip(question.question), at: question.askedAt, sessionId, ...(roomId ? { roomId } : {}) })
    }
    for (const [sessionId, card] of Object.entries(state.views ?? {})) {
      if (card === undefined || card === null) continue
      const roomId = roomOfSession(sessionId)
      add(botOfSession(sessionId), 'unresolved', { kind: 'view', key: `view:${card.id ?? sessionId}`, text: clip(card.title), at: card.askedAt, sessionId, ...(roomId ? { roomId } : {}) })
    }
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      for (const request of list ?? []) {
        if (request?.status !== 'pending') continue
        add(botId, 'unresolved', { kind: 'key', key: `key:${request.id}`, text: clip(request.name, 80), ...(request.purpose ? { detail: clip(request.purpose) } : {}), at: request.askedAt, ...(request.sessionId ? { sessionId: request.sessionId } : {}) })
      }
    }
    for (const approval of rt.approvalsView?.() ?? []) {
      add(approval.botId, 'unresolved', { kind: 'approval', key: `approval:${approval.id}`, text: clip(approval.tool, 80), ...(approval.reason ? { detail: clip(approval.reason) } : {}), at: approval.at, sessionId: approval.sessionId, ...(approval.roomId ? { roomId: approval.roomId } : {}) })
    }
    const byName = new Map(Object.values(state.bots ?? {}).map(bot => [bot.name, bot.id]))
    for (const decision of decisions()) {
      const { owner, id, ...rest } = decision
      add(byName.get(owner), 'unresolved', { kind: 'decision', key: `decision:${id}`, id, ...rest })
    }

    for (const [botId, work] of Object.entries(rt.workView?.() ?? {})) {
      add(botId, 'active', { kind: 'turn', key: 'turn', at: work.since, ...(work.tool ? { tool: work.tool } : {}), ...(work.target ? { target: work.target } : {}), ...(work.said ? { text: clip(work.said, 160) } : {}), ...(work.switching ? { switching: true } : {}), ...(work.roomId ? { roomId: work.roomId } : {}) })
    }
    for (const [id, work] of Object.entries(state.works ?? {})) {
      if (work?.to === undefined || work.from === undefined || work.to === work.from) continue
      add(work.to, 'active', { kind: 'order', key: `order:${id}`, from: work.from, at: work.at })
    }
    for (const [botId, waiting] of Object.entries(rt.waitingView?.() ?? {})) {
      add(botId, 'active', { kind: 'waiting', key: 'waiting', bots: waiting.bots ?? [], rooms: waiting.rooms ?? [] })
    }

    // Oldest first: what has waited longest sits on top.
    for (const entry of Object.values(view)) {
      for (const list of [entry.active, entry.unresolved]) list.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
    }
    return view
  }

  rt.operatorTasksView = operatorTasksView
}
