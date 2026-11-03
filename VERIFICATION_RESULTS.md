# VERIFICATION_RESULTS (ds-bot, NeoTech installed stack)

## 2026-11-03 dsbot-027-upgrade: phase 4 live proof, all five PASS

Evidence folder: `C:\Projects\logs\2026-11-03-dsbot-027\`.

| # | Proof | Result | Evidence |
|---|---|---|---|
| 0 | Gates before install | npm test 1660 run, 1658 pass, 0 fail, 2 skipped. `build-client --check` exit 0. Lint 0 errors. CI run 41704581395: Node 22 and Node 24 green, leak scan red (LE-20261103-033). | `gate-test-2.txt`, `gate-check.txt`, `gate-lint.txt` |
| 0 | Install read-back | 82 of 82 installed files match `9603b01`, all 9 markers present. | `live-compare.json`, `live-markers.txt` |
| 1 | Processes started after the install | 30 processes, earliest 2026-11-03T21:38:51.80Z, main window PID 47400; old PIDs gone. | `phase4-processes-2.json` |
| 2 | Gate loaded after restart | `card-gate.log` gate-loaded lines at 21:13:14.662Z and 21:39:25.029Z. | `C:\Users\SteveDempsey\.dsh\bot\logs\card-gate.log` |
| 3 | void_question in the installed build | installed package.json 0.2.7; void_question in constants.js:67, tools.js:714, privacy.js:198, prompt.js:34, turns.js:283. | live profile `node_modules\ds-bot\src\host\` |
| 4 | HANDED_BACK fires | PASS. Igor's session `session-bbf16cbd` seq 1479 at 2026-11-03T21:48:10.750Z: message from Eye In The Sky with `source.deferred=true, handedBack=true`, answered at seq 1480. First boot also fired at seq 1279, 21:29:10.580Z. | `phase4-handedback-pass.txt` (sha256 84826C04...91B4D6), `phase4-handedback-scan.txt` |
| 5 | Screenshot of the running GUI | PID 47400 window, 1477x874. | `phase4-gui-2.png` sha256 B35B6B42...8E7E |

Note on #4: `chat-index.sqlite` lags the session logs (max row 21:22:14Z at read time), so an index-only read reports no hand-back after the restart. The pass comes from decoding the zstd session logs frame by frame (`tools\scan_handback.mjs`).
