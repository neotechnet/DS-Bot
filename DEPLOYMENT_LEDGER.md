# DEPLOYMENT_LEDGER (ds-bot, NeoTech installed stack)

ds-bot is local desktop software. Nothing deploys on merge; a change ships only when it is installed into the live profile and proven running.

## 2026-11-03 ds-bot 0.2.7 plus local stack into the live desktop profile

- Target: `C:\Users\SteveDempsey\.dsh\profiles\desktop` (DeepSeek Harness 0.2.1-rc.5).
- Source: `stack/installed-0.2.7` at `9603b01` (fork PR #4).
- Installed: 2026-11-03 19:52:28Z to 19:52:37Z, `pnpm install` (pnpm 11.28.5) exit 0. patch_hash `73316542d9efddc6b01a6c36f13d71dab5922c272b97d6c8ae828f499e9ecba9`.
- Live from: app restart about 21:12Z, again 21:38Z (operator restarts, not forced by the agent).
- Proven: all five phase 4 proofs, see VERIFICATION_RESULTS.md 2026-11-03.
- Previous: 0.2.6 plus local stack. Snapshot `C:\Users\SteveDempsey\.claude\Exports\2026-11-03_dsbot-pre-027-snapshot\`.
