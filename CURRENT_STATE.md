# CURRENT_STATE (ds-bot, NeoTech installed stack)

## 2026-11-03 dsbot-027-upgrade: 0.2.7 plus local patches installed and proven live

- The live profile `C:\Users\SteveDempsey\.dsh\profiles\desktop` runs ds-bot 0.2.7 with the local patch stack replayed on top.
- Branch `stack/installed-0.2.7` on the fork (neotechnet/DS-Bot), head `9603b01`, two commits over upstream `v0.2.7`: `21eff5d` (carry the 0.2.6 stack onto 0.2.7) and `9603b01` (write the card gate log synchronously).
- PR https://github.com/neotechnet/DS-Bot/pull/4, base `upstream/v0.2.7`. It records the installed stack; it is not merged and is not meant for upstream as is.
- Installed 2026-11-03 19:52:28Z to 19:52:37Z with `pnpm install`: 82 of 82 files match `9603b01`, patch_hash `73316542d9efddc6b01a6c36f13d71dab5922c272b97d6c8ae828f499e9ecba9`.
- DeepSeek Harness 0.2.1-rc.5 restarted twice afterwards (about 21:12Z and 21:38Z). All five phase 4 proofs pass on the second boot (see VERIFICATION_RESULTS.md).
- Rollback: copy back the 3 files in `C:\Users\SteveDempsey\.claude\Exports\2026-11-03_dsbot-pre-027-snapshot\` and run `pnpm install` in the profile.
- Known red: the CI leak scan, accepted under LE-20261103-033 (the `dsh-bot:sessions` to `ds-bot:sessions` rename).
