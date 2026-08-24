# wa-audit

**A commercial audit of your WhatsApp business number.** Point it at a
[WAHA](https://github.com/devlikeapro/waha) instance and it exports the full
chat history, builds a clean conversation corpus, runs an LLM analysis that is
**verified against the corpus before it reaches you**, and delivers a
multi-sheet XLSX report: response times, real FAQs, customer archetypes,
objections, what a bot could actually resolve — with a methodology sheet that
records what the verification *refuted*.

Everything runs on your machine. The only outbound traffic in the whole
pipeline is the phase-4 analysis call to the LLM provider **you** configure —
and even that goes away with `llm.provider: "mock"` or a self-hosted
OpenAI-compatible endpoint, for a fully offline run.

*Leé esto en castellano: [README.es.md](README.es.md).*

---

## ⚠️ Read this first

> This project is **not affiliated with, associated with, authorized by,
> endorsed by, or in any way officially connected with WhatsApp, Meta
> Platforms Inc.**, or any of their subsidiaries. "WhatsApp" and "Meta", and
> related names, marks and images, are trademarks of their respective owners.
> The official WhatsApp website is https://whatsapp.com.
>
> It is also not affiliated with the WAHA project. This tool only consumes the
> HTTP API of a WAHA instance **you** operate; it does not redistribute,
> bundle or modify WAHA (which is Apache-2.0, obtainable from its official
> repository).
>
> WAHA uses unofficial methods to access WhatsApp. **WhatsApp does not allow
> bots or unofficial clients on its platform**, and there is no guarantee your
> account will not be blocked. The maintainers of this project **do not
> condone any use that violates WhatsApp's Terms of Service** and explicitly
> discourage bulk messaging, spam, stalkerware, or surveillance of people.
> For business-critical integrations, consider the official WhatsApp Business
> API. The intended use case is a business analyzing **its own** conversation
> history.
>
> **Personal data:** chat history is personal data of third parties. You are
> solely responsible for having a valid legal basis to process it and for
> complying with the law that applies to you (GDPR, LGPD, Ley 25.326, …).
> Processing happens on your own infrastructure and this project transmits
> nothing to its authors. The one outbound flow is the analysis phase, which
> sends a corpus digest to the LLM provider you configure — none at all with a
> local or mock provider. Choose your provider accordingly.
>
> This software is provided "AS IS", without warranty of any kind.

---

## Why the verifier is the whole point

This pipeline was built for a real business: **11,782 messages, 610
conversations, 8 months of history**. The LLM analysis produced 60 findings
across 7 dimensions. Then each dimension went through an independent verifier
that re-located every quote and re-counted every claim against the corpus.

**The verifier refuted 34 of the 60 findings.**

Plausible, well-written, confidently-numbered findings — and more than half of
them didn't survive contact with the data. An LLM analysis of your business
without a verification pass isn't analysis; it's fiction with nice formatting.
That's why in this project:

- every finding must cite **verbatim evidence** (`thread_id` + quote), and a
  deterministic code check refutes any finding whose quote doesn't exist in
  the corpus — no model gets a vote on that;
- a **second, independent LLM pass** re-counts every frequency claim and
  refutes what doesn't hold as stated;
- the schema makes the verdict **required**: an analysis without a recorded
  verification pass is invalid by construction;
- the report's methodology sheet **prints the refuted findings**, so nobody
  re-cites the bad numbers later.

## Two analysis lenses: commercial + FATE behavioral

The analysis ships with two dimension sets, both subject to the same
mandatory verification:

- **Commercial** (7 dimensions): real FAQs, response times and operations,
  customer archetypes, products and topics, objections and friction, bot
  opportunities, tone and style.
- **FATE behavioral** (5 dimensions, `npm run analyze -- --dimensions fate`):
  how the business captures attention (*Focus*), projects certainty and keeps
  its word (*Authority*), makes clients feel understood (*Tribe*), reaches the
  emotional layer instead of dumping specs (*Emotion*), and reads customer
  state signals — clusters only, benign explanations first, **states, never
  verdicts about individuals**. Inspired by the FATE model in Chase Hughes'
  *The Behavior Ops Manual* (original articulation; not affiliated with or
  endorsed by the author). Interview your operator first and feed
  `business-context.json` — see [analysis/PLAYBOOK.md](analysis/PLAYBOOK.md).

## Try it in two minutes (no WhatsApp needed)

```bash
git clone <this repo> && cd wa-audit
npm install
npm run demo
```

The demo generates a synthetic corpus, starts a mock WAHA server, runs the
entire pipeline against it (probe → export → corpus → verified analysis →
report) with a mock LLM, and leaves the report in `out/demo/` in all three
formats — **XLSX** (the client spreadsheet), **HTML** (shareable single file)
and **DOCX** (Word). No keys, no network, no real data.

## Run it against your real WhatsApp

You need a running [WAHA](https://waha.devlike.pro/) instance with your
business number connected — see [docs/waha-setup.md](docs/waha-setup.md) for
the traps that cost us days (engine choice, `fullSync`, device slots, @lid).

```bash
cp waha.env.example waha.env        # fill in WAHA_BASE_URL + WAHA_API_KEY
# 0. read-only probe: right engine? how deep does the history go?
node --env-file=waha.env src/probe.mjs
# 2. dump the raw history (resumable)
node --env-file=waha.env src/export.mjs <session-name>
# 3. clean corpus: threads.json + messages.csv + summary.json
node --env-file=waha.env src/threads.mjs --session <session-name>
# 4. LLM analysis with mandatory verification (needs ANTHROPIC_API_KEY,
#    or any OpenAI-compatible endpoint — see Configuration)
node --env-file=waha.env src/analyze.mjs
# 5. the report, in any or all formats
node src/report-xlsx.mjs && node src/report-html.mjs && node src/report-docx.mjs
```

Prefer to run the analysis with your own agent (Claude Code, Cursor, anything)
instead of the built-in engine? That's a first-class path:
[analysis/PLAYBOOK.md](analysis/PLAYBOOK.md).

## Or let Claude drive the whole thing (MCP)

`npm run mcp` starts an MCP server that turns Claude Desktop / Claude Code /
ChatGPT / Cursor into the audit engine: the agent interviews you, guides the
WAHA setup, shows the pairing **QR right in the chat**, exports the history
and runs the analysis itself. The server keeps it honest structurally —
`submit_dimension` rejects any dimension without a recorded verification
verdict, every evidence quote is re-checked server-side against the corpus,
and chat content is served as untrusted data. It never sends a WhatsApp
message. Setup: [docs/mcp-setup.md](docs/mcp-setup.md).

## The pipeline

```
 probe ──► export ──► threads ──► analyze ──► report-xlsx
 (0)       (2)        (3)         (4)         (5)
 read-only raw dump   clean       LLM + two-  11-sheet XLSX
 sanity    JSONL,     corpus,     layer       with styles,
 check     resumable  @lid        verifier    frozen panes &
                      resolution              a methodology
                      + metrics               sheet
```

Each phase reads and writes plain local files (default `data/wa-history/`),
so you can rerun any phase without repeating the previous ones — the dump is
never re-scraped because of a parsing bug.

## Configuration

Copy [`wa-audit.config.json`](wa-audit.config.json) and edit, or use env
overrides (env wins). The essentials:

| Key | Default | What it does |
|---|---|---|
| `business.name` | `"My Business"` | Name printed on the report |
| `business.internalNumbers` | `[]` | Own lines, excluded from client metrics |
| `business.internalEmailDomains` | `[]` | CRM emails that mark internal lines |
| `phone.defaultCountry` | `"AR"` | Country for CRM numbers without prefix |
| `timezone.utcOffset` | `"-03:00"` | Fixed offset for local timestamps |
| `locale` | `"es-AR"` | Number formatting in the report |
| `crm.file` | `null` | Optional CRM CSV (`phone,whatsapp,name,contact,email,segment,stage,location`) |
| `llm.provider` | `"anthropic"` | `anthropic` \| `openai` (any compatible endpoint) \| `mock` |
| `llm.model` | `null` | `anthropic` falls back to `claude-opus-5`; `openai` requires an explicit model |

Secrets are env-only: `WAHA_BASE_URL`, `WAHA_API_KEY` (+ `ANTHROPIC_API_KEY`
or `LLM_API_KEY` for phase 4). `WAHA_BASE_URL` has **no default on purpose**
— pointing at the wrong instance is the expensive mistake.

The report's prose is currently Spanish (es-AR preset); the data contract
underneath is English. Prose i18n is on the roadmap.

## Data contract

`threads.json`, `summary.json` and `analysis.json` are versioned
(`schema_version: 1`) and documented in
[docs/data-contract.md](docs/data-contract.md). The analysis contract is
formalized in [analysis/analysis.schema.json](analysis/analysis.schema.json)
(`npm run check:analysis`): **any engine that emits valid `analysis.json` —
LLM, rules, SQL, a human — plugs into the report without changes.**

## Honest limitations

- WAHA's bulk-history endpoint only exists on the **NOWEB/GOWS** engines;
  WEBJS would need chat-by-chat export (unsupported here — the probe tells you).
- History depth beyond ~3 months requires creating the session with
  `noweb.store.fullSync` **before** dumping ([docs/waha-setup.md](docs/waha-setup.md)).
- Response-time medians anchor at the **first** message of each inbound burst,
  and outbound messages don't distinguish humans from bots — both stated in
  the report's methodology sheet.
- Media has no analyzable text (`downloadMedia=false`): photos and voice notes
  appear typed but empty.
- `xlsx@0.18.5` (pinned: the styles post-processing depends on it) has a known
  upstream advisory (prototype pollution / ReDoS on *untrusted* spreadsheets).
  This project only **writes** XLSX and reads back its own output, so the
  vector doesn't apply — but `npm audit` will flag it and we'd rather tell you
  than hide it.
- The XLSX styling works by post-processing the file as a ZIP — deliberate,
  documented black magic: [docs/xlsx-postprocess.md](docs/xlsx-postprocess.md).

## Development

```bash
npm test                 # unit + two end-to-end lanes against goldens
node fixtures/generate.mjs   # regenerate the deterministic synthetic fixture
node test/record-golden.mjs  # re-record goldens (review the diff like a spec)
```

Everything in `fixtures/` is synthetic and invented. No real conversation,
phone number or name from any actual business exists in this repository.

## License

[MIT](LICENSE).
