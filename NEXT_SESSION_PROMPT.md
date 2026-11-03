# NEXT_SESSION_PROMPT (ds-bot, NeoTech installed stack) - snapshot 2026-11-03

ds-bot 0.2.7 plus the local stack is installed and proven live (fork branch `stack/installed-0.2.7`, head `9603b01`, PR neotechnet/DS-Bot#4). Read CURRENT_STATE.md and VERIFICATION_RESULTS.md first.

Next, in order:
1. Close fork PRs #1 to #3 if still open, delete their branches, read back.
2. 06-ds-bot-plugin.md playbook draft to Igor.
3. dsbot-view-guard-patch-name write-up.
4. dsbot-card-routing-overlord (approved, Choice A plus H3): new worktree from `stack/installed-0.2.7`, scope `ds-bot/src/host`, `ds-bot/test`.
5. LE-20261103-033 rename, due 2026-11-10.

Rules: never write `~\.dsh\bot\state.json`; never force-restart the app; proof from live reads only. For hand-back proofs, decode the session logs (`C:\Projects\logs\2026-11-03-dsbot-027\tools\scan_handback.mjs`), not chat-index.sqlite alone.
