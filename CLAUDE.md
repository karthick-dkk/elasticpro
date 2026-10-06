# ElasticPro

Portable Windows desktop app (Tauri 2 + Rust core + unbundled vanilla ES modules) for
monitoring multiple Elasticsearch clusters, including clusters reachable only through SSH
jump hosts. Also runs hosted on Linux behind nginx — same core, same UI.

## Conventions that matter

- **One definition per quantity.** This codebase has drifted three times by computing the
  same figure in two places (card labels vs CSV columns; snapshot day-span in `volume.js`
  vs `snapshots.js`). Export the definition, have both callers use it.
- **The UI ships unbundled.** No build step for `ui/`. `tools/check-ui.mjs` resolves every
  named import; `tools/render-check.mjs` renders all 11 pages in jsdom. A missing import
  that only fires at runtime is caught by the second, not the first — run both. A page
  can also draw perfectly and be unusable, which is what `tools/behaviour-check.mjs` is
  for: it presses things.
- **Unknown is not zero.** When Elasticsearch cannot report something (repository size,
  index names inside a `_cat` snapshot listing), the UI says so and names the setting that
  would fix it. Never render a guess as a measurement.
- **Writes are gated twice.** `Writes::decide(read_only, unlocked, requested)` — a write
  needs both the guard unlocked and an action the operator took by hand. The one thing
  that writes unattended, the scheduled log-delay measurement in `delay_sink.rs`, is
  hosted-only and still takes two people-made decisions: the config must already permit
  writes, and an admin must have armed it.

## Verifying a change

```bash
node tools/check-ui.mjs                               # imports resolve
node tools/unit-check.mjs                             # pure arithmetic, no DOM
node tools/render-check.mjs --config <fixture.json>   # all 11 pages render
node tools/behaviour-check.mjs --config <fixture.json> # and the ones with behaviour
tools/hosted-check.sh                                 # the hosted message contract
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
deploy/trial.sh                                       # hosted stack, four security properties
```

`npm i jsdom` before any of it. `render-check` and `behaviour-check` print "jsdom not
found — skipping" and exit 0 without it, which has looked like a pass before now; and
part of `unit-check` builds DOM nodes, so those files fail outright when it is absent —
which is how three of them went red on main while passing on every machine that already
had it.

`tools/mock-es.mjs` is the fixture cluster. When a page looks like it contradicts itself,
curl the raw mock endpoints before filing a bug — the fixture has been wrong before.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
