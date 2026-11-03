# OPEN_ISSUES (ds-bot, NeoTech installed stack) - snapshot 2026-11-03

- LE-20261103-033: rename `dsh-bot:sessions` to `ds-bot:sessions` in ds-bot and deepseek-harness, Harness listening on both names for one release. Owner Harness Code, due 2026-11-10. Clears the red CI leak scan, which stays accepted until then.
- dsbot-card-routing-overlord: PLAN-APPROVED (Choice A plus H3), queued. Drop the `refuseCard` production-label exemption (card-gate.js line 83), gate interactive show_view in gated turns, log allowed cards with the deciding label, accept a non-Main manager on the PLAN-APPROVED release (today `sender-not-main`), tests for all.
- dsbot-view-guard-patch-name: change write-up for `ds_bot_view_guard.py` (Harness Code writes the description only, not the file).
- 06-ds-bot-plugin.md playbook draft for Igor.
- Fork PRs #1 to #3 on neotechnet/DS-Bot to close (superseded by #4).
- chat-index.sqlite lags the session logs (seen 2026-11-03, index 30 min behind). Any proof that reads only the index can miss recent events; read the session logs.
- Not ours: H1 and H2 (guard-composio-write-coverage) belong to NeoTech Code.
