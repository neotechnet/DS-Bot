// The composer's Brainstorm row. It only types the word at the caret: the word itself
// is what switches a Bot into its show-me-options-first stance (the operator's
// AGENTS.md), so no mode flips and nothing else is sent.
export const BRAINSTORM_TEXT = 'brainstorm '

export const canBrainstorm = inputActions => typeof inputActions?.insertText === 'function'

export function insertBrainstorm(inputActions) {
  if (!canBrainstorm(inputActions)) return false
  inputActions.insertText(BRAINSTORM_TEXT, inputActions.captureInsertion?.())
  return true
}
