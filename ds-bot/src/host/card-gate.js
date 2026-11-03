// The card gate: decisions follow the job back to the Bot that sent it.
//
// A job a Bot sends another Bot runs in a hidden turn: the user does not watch it.
// A question card or a plan review raised there lands in the sub-agent's own chat,
// away from the conversation the user started the job in, so the gate refuses it
// and sends the decision back to the sender (the manager) instead. The manager
// cards the user and relays the answer; a plan approval relayed by a Main Bot with
// PLAN-APPROVED turns the sub-agent's plan mode off with no card.
//
// What stays open: a Main Bot's own cards, every turn the user typed, a request
// whose audience is the user, a card whose option is the production approval
// (the production guard only reads the transcript of the Bot that runs the
// command), and a job whose text carries CARD-IT-YOURSELF.
//
// DSH_CARD_GATE=off turns all of it off.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CARD_IT_YOURSELF = 'CARD-IT-YOURSELF'
export const PLAN_APPROVED = 'PLAN-APPROVED'
export const EXIT_PLAN_MODE = 'exit_plan_mode'
const PRODUCTION_LABEL = /^deploy to production( \(Recommended\))?$/i
const TITLE_MAX = 200

export const gateOn = (env = process.env) => String(env.DSH_CARD_GATE ?? '').trim().toLowerCase() !== 'off'

export const isProductionLabel = label => PRODUCTION_LABEL.test(String(label ?? '').trim())

const clip = text => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > TITLE_MAX ? `${value.slice(0, TITLE_MAX - 3)}...` : value
}

/** The plan's first markdown heading, or its first line. */
export const planTitle = (plan) => {
  for (const line of String(plan ?? '').split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return clip(match[1])
  }
  return clip(String(plan ?? '').split('\n').find(line => line.trim() !== '') ?? '')
}

// Who sent the job a trigger carries: its Bot's name, else the name on the message.
const senderOf = (rt, info) => rt.botOf?.(info?.senderSessionId)?.name ?? info?.senderName ?? 'the Bot that sent this job'

/**
 * The gate's view of the turn running in a Session: undefined when the turn is not
 * one a Bot opened (no gate), else who runs it, who sent it, and whether it may card.
 */
export function gatedTurn(rt, sessionId) {
  if (!gateOn()) return undefined
  const { state } = rt
  const entry = rt.live?.get(sessionId)
  const turn = entry?.turn
  if (turn === undefined || !(state.exchangeTurns?.[sessionId] ?? []).includes(turn)) return undefined
  const botId = rt.chatOwners?.get(sessionId)
  if (botId === undefined || rt.isMain?.(botId)) return undefined
  const info = entry.info
  // A request the user sees answered here is the user's turn as much as the Bot's.
  if (info?.audience === 'user') return undefined
  const triggers = [{ info, text: entry.infoText }, ...(entry.joined ?? [])]
  const texts = triggers.flatMap(({ info: item, text }) => {
    const record = (state.exchanges ?? []).find(other => other.id === item?.exchangeId)
    return [text, record?.text].filter(value => typeof value === 'string')
  })
  return {
    bot: rt.botOf?.(botId)?.name ?? botId,
    manager: senderOf(rt, info),
    cardItYourself: texts.some(text => text.includes(CARD_IT_YOURSELF)),
  }
}

export const cardRefusal = manager => `This job came from ${manager}. Do not card Steve: end your turn with a DECISION block for ${manager} (question, 2 to 4 options, the recommended one marked with its reason, Hold). ${manager} cards Steve and relays his answer.`

export const planRefusal = manager => `This job came from ${manager}. Do not open a plan review for Steve here: send the full plan to ${manager} as a DECISION (Approve plan (Recommended) / Change it / Hold). When ${manager} relays approval with ${PLAN_APPROVED}, plan mode turns off for you.`

/** Whether ask_user in this Session is refused; the refusal text, or undefined. */
export function refuseCard(rt, sessionId, options) {
  const gated = gatedTurn(rt, sessionId)
  if (gated === undefined || gated.cardItYourself) return undefined
  if ((options ?? []).some(option => isProductionLabel(option?.label))) return undefined
  return { ...gated, text: cardRefusal(gated.manager) }
}

/** Whether exit_plan_mode in this Session is refused; the refusal text, or undefined. */
export function refusePlan(rt, sessionId) {
  const gated = gatedTurn(rt, sessionId)
  if (gated === undefined || gated.cardItYourself) return undefined
  return { ...gated, text: planRefusal(gated.manager) }
}

/**
 * One JSON line in <home>/logs/card-gate.log. Only names, the tool and a title.
 * Written synchronously: a fire-and-forget async write could land after the host
 * stopped and its folder was removed (seen as ENOTEMPTY in test teardown on Node 22).
 */
export function logGate(rt, entry) {
  if (typeof rt.home !== 'string') return Promise.resolve()
  const path = join(rt.home, 'logs', 'card-gate.log')
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry, ...(entry.title !== undefined ? { title: clip(rt.redactSecrets?.(entry.title) ?? entry.title) } : {}) })
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${line}\n`, 'utf8')
  } catch (error) {
    rt.warn?.('ds-bot: card gate log not written: %s', error?.code ?? error)
  }
  return Promise.resolve()
}

// A job a Main Bot hands out opens with this line; it carries the manager's
// approval to start, so the Bot it reaches is not left waiting in plan mode.
export const ORDER_PREFIX = /^ORDER from .+? · job /
export const orderReleaseOn = (env = process.env) => String(env.DSH_ORDER_RELEASE ?? '').trim().toLowerCase() !== 'off'

/** Which release a message carries: 'plan-approved', 'order', or undefined. */
export function releaseKind(text, env = process.env) {
  const value = String(text ?? '')
  if (value.includes(PLAN_APPROVED)) return 'plan-approved'
  if (orderReleaseOn(env) && ORDER_PREFIX.test(value.trimStart())) return 'order'
  return undefined
}

/**
 * A Main Bot's message that relays a plan approval (PLAN-APPROVED), or hands out a
 * job (an ORDER line), turns plan mode off in the Session it reaches, whether that
 * Bot is a Main Bot or not: at once between turns, from the next step inside one.
 * Every attempt is logged with its outcome, so a release that did nothing says why.
 * Returns what planMode.set said, or undefined when nothing was done.
 */
export function relayPlanApproval(rt, { fromId, toId, agent, text }) {
  if (!gateOn()) return undefined
  const kind = releaseKind(text)
  if (kind === undefined) return undefined
  const log = (outcome) => {
    void logGate(rt, { bot: rt.botOf?.(toId)?.name ?? toId, manager: rt.botOf?.(fromId)?.name ?? fromId ?? 'unknown', tool: kind, outcome })
  }
  if (fromId !== undefined && fromId === toId) { log('self'); return undefined }
  if (fromId === undefined || !rt.isMain?.(fromId)) { log('sender-not-main'); return undefined }
  const planMode = planModeFor(rt, agent)
  if (planMode === undefined || agent === undefined) { log('no-plan-service'); return undefined }
  let outcome
  try {
    const now = planMode.get(agent)
    if (!(now.pending ?? now.active)) { log('not-in-plan-mode'); return undefined }
    outcome = planMode.set(agent, false)
  } catch (error) {
    rt.warn?.('ds-bot: relayed plan approval not applied: %s', error)
    log('error')
    return undefined
  }
  log(outcome)
  return outcome
}

/**
 * The plan-mode service that serves this agent. Under an agent preset, plan mode
 * lives in the preset's isolated group (`isolate: planMode: true`), so a Host-realm
 * `ctx.get('planMode')` finds nothing: the preset composition is read first.
 */
export function planModeFor(rt, agent) {
  if (agent === undefined) return undefined
  return rt.ctx?.get?.('agentPresets')?.serviceFor?.(agent, 'planMode') ?? rt.ctx?.get?.('planMode')
}

/**
 * Bots that keep plan mode on, by name: <home>/plan-mode-keep.json, a JSON array of
 * names. Read on each call (it is tiny), so an edit needs no restart.
 */
export function keepsPlanMode(rt, name) {
  if (typeof rt.home !== 'string' || typeof name !== 'string') return false
  try {
    const list = JSON.parse(readFileSync(join(rt.home, 'plan-mode-keep.json'), 'utf8'))
    return Array.isArray(list) && list.some(item => String(item).trim().toLowerCase() === name.trim().toLowerCase())
  } catch {
    return false
  }
}

export const planDefaultOffOn = (env = process.env) => String(env.DSH_PLAN_DEFAULT_OFF ?? '').trim().toLowerCase() !== 'off'

/**
 * A Bot Session does not start in plan mode: DSH's shipped presets pin it on for
 * every new Session (`defaultActive: true`), and Steve's rule is off by default.
 * Each Session is switched off once, recorded in `state.planDefaultOff`, so a later
 * /plan in that chat is the user's choice and stays on. A Bot with
 * `planMode: 'on'` is left alone. Returns the outcome, or undefined.
 */
export function ensurePlanOff(rt, agent, why, { fresh = false } = {}) {
  if (!planDefaultOffOn()) return undefined
  const sessionId = agent?.session?.id ?? agent?.id
  if (sessionId === undefined) return undefined
  // A Session DS Bot has just made for a Bot is not yet in the owner tables.
  const botId = rt.selfOf?.(sessionId)
  if (botId === undefined && !fresh) return undefined
  const done = rt.state?.planDefaultOff ?? (rt.state === undefined ? undefined : (rt.state.planDefaultOff = {}))
  if (done === undefined || done[sessionId] !== undefined) return undefined
  const bot = rt.botOf?.(botId)
  const log = (outcome) => { void logGate(rt, { bot: bot?.name ?? botId ?? sessionId, tool: 'plan-default-off', why, outcome }) }
  if (bot?.planMode === 'on' || keepsPlanMode(rt, bot?.name)) { done[sessionId] = 'kept'; log('kept-bot-opt-in'); void rt.save?.().catch?.(() => {}); return 'kept' }
  const planMode = planModeFor(rt, agent)
  if (planMode === undefined) { log('no-plan-service'); return undefined }
  let outcome
  try {
    const now = planMode.get(agent)
    outcome = (now.pending ?? now.active) ? planMode.set(agent, false) : 'already-off'
  } catch (error) {
    rt.warn?.('ds-bot: plan default-off not applied: %s', error)
    log('error')
    return undefined
  }
  done[sessionId] = outcome
  void rt.save?.().catch?.(() => {})
  log(outcome)
  return outcome
}

/** One line at start-up, so the log proves this code is the code that is running. */
export function announceGate(rt) {
  if (!gateOn()) return Promise.resolve()
  return logGate(rt, { tool: 'gate-loaded', release: 'plan-approved+order', orderRelease: orderReleaseOn(), planDefaultOff: planDefaultOffOn(), lookup: 'agentPresets.serviceFor' })
}
