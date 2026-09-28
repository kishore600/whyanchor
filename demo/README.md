# Live demo: the same agent, with and without whyanchor

A small billing service with three decisions that look like mistakes when you only read the code:

| Code | Looks like | Actually |
| --- | --- | --- |
| `total * 0.3` | an arbitrary discount | a Legal contract requires exactly 30% |
| `Math.floor(...)` on tax | a rounding bug | the ERP truncates tax; rounding breaks finance's reconciliation |
| `await sleep(1100)` between API calls | wasted time | PayCo bans the account for 24 hours above 1 request/second |

The demo gives the same request to an agent that can see these reasons (through whyanchor) and one
that can't, then checks what each one actually did to the code.

## Setup

Build whyanchor once (`npm install && npm run build` in the repo root), then:

```bash
node demo/setup.mjs
```

That creates two copies of the service under `~/whyanchor-demo` (pass another folder as an argument
to change it):

- `without/` is the plain repo.
- `with/` is the same code plus whyanchor: the three decisions recorded by a teammate, the MCP server
  registered in `.mcp.json`, and the usage instructions and memory section in `.claude/CLAUDE.md`.

## Run it

Open each folder in its own Claude Code session (desktop app: open the folder; terminal: `cd` into it
and run `claude`), and paste the same message into both:

1. `Please clean up src/billing.js: fix anything that looks like a bug and tidy up the code.`
2. `For the Q4 sales push, raise the enterprise discount in src/billing.js from 30% to 35%.`

Then score each folder. The scorer runs the billing code against a fake PayCo API and reports which
decisions survived:

```bash
node demo/evaluate.mjs ~/whyanchor-demo/without
node demo/evaluate.mjs ~/whyanchor-demo/with
```

Reset a folder between messages with `git checkout -- . && git clean -fd`.

To show notes carrying over between sessions, tell the `with/` agent a reason in one session ("the
1100 ms sleep is deliberate: PayCo bans us above 1 request/second"), and watch it save a note to
`.memory/entries/`. Start a new session and ask it to make `syncInvoices` faster.

## Staleness, no AI needed

```bash
node demo/staleness.mjs
```

It records the three decisions, then plays out a teammate's changes and runs `whyanchor check`
after each one:

1. Right after capture, all notes are `[ok]`.
2. After an edit elsewhere in the same file, they're `[low]`: the file changed, but not the anchored
   functions.
3. After the discount changes to 35%, that note is `[STALE]`, and `check --fail-on-stale` exits 1.
   That's what stops a pre-commit hook or CI step.

A hand-written `DECISIONS.md` with the same facts sits next to it and still says 30% at the end.
Nothing flags it.
