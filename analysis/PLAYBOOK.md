# Analysis playbook — run phase 4 with your own agent

`src/analyze.mjs` is one implementation of the analysis phase. It is not the
contract. **The contract is [`analysis.schema.json`](analysis.schema.json):**
anything that emits a valid `analysis.json` — an LLM agent, a rules engine,
a SQL script, a human with a text editor — is a first-class analysis engine,
and `npm run report` will render it without knowing the difference.

This playbook is for running the analysis with an interactive agent (Claude
Code, Cursor, or any LLM you drive by hand) instead of the built-in engine.
It is also how the original analysis was produced.

Two dimension sets ship in [`prompts/`](prompts/): the seven commercial
dimensions (FAQs, response times, archetypes, objections...) and the five
**FATE behavioral dimensions** (`fate_*`) — attention, authority, belonging,
emotion and customer-state signals, inspired by the FATE model in Chase
Hughes' *The Behavior Ops Manual* (original articulation, not affiliated).
The FATE set is more interpretive, which makes the verifier pass MORE
important there, not less — and `fate_customer_signals` carries hard rules
(states, never verdicts about individuals) that outrank everything else.

## Why the verifier is not optional

In the original run of this methodology (11,782 real messages, 7 dimensions),
independent verification **refuted 34 of 60 findings** before the report
shipped. Without that step, more than half the numbers in the deliverable
would have been wrong — confidently wrong, with nice formatting. That is why
`verdict` is a *required* field in the schema: an analysis without a recorded
verification pass is invalid by construction, and the report prints the
refuted findings so nobody re-cites the bad numbers later.

## Inputs

From your output directory (default `data/wa-history/`):

- `threads.json` — the corpus: one object per conversation, messages included.
- `summary.json` — deterministic counters for the whole corpus. **These
  numbers win every conflict with an impression from reading conversations.**

## Procedure

0. **Interview the operator first.** Before any analysis, ask the business
   owner what they sell, to whom, how the sales process works, who answers
   this number, what they already suspect is broken, and what tone they intend
   — then save the answers as `business-context.json` in the output directory
   (template: [`business-context.example.json`](business-context.example.json)).
   Both the built-in engine and this playbook's agents must receive it:
   findings grounded in how the business actually operates beat generic ones.
1. **One agent per dimension.** Give each agent:
   - the dimension prompt from [`prompts/`](prompts/) (one file per dimension;
     the first line is the sheet title),
   - `summary.json` in full,
   - as much of `threads.json` as fits its context (prioritize two-way,
     non-internal threads; if you cut, tell the agent what was cut).
2. **Demand evidence.** Every finding must cite `{"thread_id", "quote"}` where
   the quote is a verbatim substring of a message in that thread. No evidence,
   no finding.
3. **Verify in a separate session.** Open a *fresh* agent with no memory of
   the generator's reasoning. Give it [`prompts/verifier.md`](prompts/verifier.md),
   the findings, and the same corpus. Its job is to refute: re-locate every
   quote, re-count every frequency claim, and kill what does not hold as
   stated. Expect a high refutation rate; that is the method working.
4. **Record the verdict.** Remove refuted findings from `findings`, list them
   in `verdict.refuted` with `reason` and `correction`, and set
   `reviewed`/`confirmed` so the arithmetic closes.
5. **Validate and render:**

   ```bash
   npm run check:analysis
   npm run report
   ```

## Cheap automatic pre-check

Before the verifier session, you can run layer A of the built-in engine's
checks by hand: every quoted evidence must be findable with a plain text
search in `threads.json`. A finding whose quote does not appear is fabricated
evidence — refute it without discussion.

## Output shape

See [`analysis.schema.json`](analysis.schema.json) for the full contract, and
[`../fixtures/analysis-sample.json`](../fixtures/analysis-sample.json) for a
complete valid example (including refuted findings and row notes).
