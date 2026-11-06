# Operator Tasks, and the A · U badge

## Why

The Bot details panel listed two things: what the Bot was working on (Active Tasks) and
what waited on the user (Unresolved Tasks). Nothing said whether the Bot was working on
the user's own ask or on another Bot's work, so the panel could not answer the one
question the operator has while several Bots run at once: who is doing what I asked for.

This adds a third list, Operator Tasks, above Active Tasks, and replaces the single
unresolved count in the chat header with two numbers, `A · U`.

## What an Operator Task is

A job is the user's when it started from any of:

- a message the user sent to the Bot's own chat, including one they steered into a
  running turn;
- a task the user scheduled for that Bot;
- an order relayed by a manager Bot on the user's behalf, hop by hop (Igor to a coding
  Bot, and on to a Bot that coding Bot asked).

It leaves the list when the Bot's turn for that job ends, which is when the Bot sends
its reply. A job that is waiting on another Bot stays listed, through the open work it
holds (`state.works`), until the result comes back and the reply that carries it is sent.

Group chat work stays in Active Tasks. A post in a group is queued as a room message,
not a user turn, and the group already shows who was called.

## How the origin is recorded

Nothing recorded where a task came from, so the host now records it in three places:

- `src/host/turns.js`: the running turn of a Session carries `origin: 'operator'` when
  it was started by the user, by a schedule, or by a relayed order. `originFrom` names
  the manager Bot that passed it on, and `askText` keeps the user's words for the row.
  The turn's origin is exposed on `workView`, which is what the panel reads.
- `src/host/delivery.js`: a message sent while its sender works for the operator carries
  `origin: 'operator'` on its source, so each relay hop passes the origin on.
- `src/host/handoffs.js`: the work a Bot opens remembers its origin (`openWork`), so the
  job keeps it across a restart, and `workOrigin` reads it back.

A relay after a restart falls back to the work it answers, so a job does not lose its
origin when the app restarts mid-job.

## The lists

`src/host/operator-tasks.js` now returns `operator`, `active` and `unresolved` per Bot:

- a running turn whose origin is the operator (kind `ask`, or `relay` with `via`);
- an order whose work carries the operator origin;
- a wait whose open work carries the operator origin, with the age of that work.

An order stands back while the Bot's running turn for the same work is shown, so a job
appears once. No item can be in both lists, since one origin decides the list.

## The badge

`OperatorBadge` in the chat header shows `A · U`: A in the accent colour, U in the
danger colour the count used before, each capped at `99+`, and nothing at all when both
are 0. The panel keeps its three section headings with their own counts.

## The three 11/5 local hotfixes are not in this branch

The installed 0.2.7 also carries three local fixes from the 11/5 DeepSeek Harness 0.2.2
session: the pre-step and seam failure capture in `parts.js`, the tools waterfall guard
in `tools.js`, and the stack on a turn failure in `turns.js`.

They exist only in the installed copy and in `patches/ds-bot@0.2.7.patch`. Adding them to
this branch was tried and reverted: under the branch's pinned DeepSeek Harness
(`0.2.1-rc.5`, also under `0.2.2-rc.1`) they break 27 tests, because they wrap DSH
services (`tools.resolve`, `systemPrompt.assemble`) that the test host does not provide
the same way, and they change the plugin's registration list that `test/install.test.js`
fixes. Porting them is a DeepSeek Harness upgrade job, not a panel change, and the repo
rules forbid patching DSH from the plugin. The regenerated patch is built from the
installed bytes, so the running app keeps all three.

## Verification

- `npm test`, `node scripts/build-client.mjs --check` and `npm run lint` pass.
- `test/operator-tasks.test.js` drives the host: a turn the user starts is an Operator
  Task until its reply, a relayed turn carries the origin (a plain team job does not),
  the orders and waits land in the right list, and nothing is in both.
- `test/operator-tasks-client.test.js` renders the panel and the badge and asserts the
  section order, the labels, the two colours, the `99+` cap and the empty state.
- The mock test bench (`dev/bench.sh`) cannot start on this workstation: WSL has no
  distribution and Git Bash has no `setsid`. The panel was rendered from the real
  components and the real stylesheet in headless Chromium instead (screenshot in the
  session log), and the unit tests above cover the behaviour.
