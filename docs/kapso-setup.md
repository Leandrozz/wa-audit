# Kapso — the official-API path

If the business number runs on the official WhatsApp Business Platform
through [Kapso](https://kapso.ai), the audit takes the front door: Kapso
stores every message that flows through it and exposes the history over its
[Meta-proxy API](https://docs.kapso.ai/). No unofficial client, no ToS
disclaimer needed for this source, no linked-device slot, no @lid problem
(the official API always carries real phone numbers).

## Run it

```bash
cp kapso.env.example kapso.env      # KAPSO_API_KEY + KAPSO_PHONE_NUMBER_ID
node --env-file=kapso.env src/export-kapso.mjs
node src/threads.mjs --session kapso --no-net
node src/analyze.mjs                # or the MCP / playbook path
node src/report-xlsx.mjs
```

`export-kapso` writes the same `messages.jsonl` shape the WAHA exporter
produces, so everything downstream — corpus, verifier, reports, MCP — runs
unchanged. `--no-net` on the corpus phase is correct here: there is nothing
to resolve.

## What changes vs the WAHA path

| | WAHA (unofficial) | Kapso (official) |
|---|---|---|
| History depth | Full phone history (with `fullSync`) | **Only since the number joined Kapso** — the official platform has no retroactive backfill |
| ToS risk | Disclaimed, non-zero | None: it is the official API |
| @lid resolution | Needed (cache, retries) | Not applicable |
| Group chats | Present, excluded by the corpus | Don't exist on the Cloud API |
| Voice notes | Distinguished from audio | Typed `audio` (the Cloud API doesn't flag `ptt`) |
| Resume | Appends/resumes | Rewrites each run (Kapso's store is the durable copy) |

## Try it without an account

`node fixtures/mock-kapso.mjs` serves the synthetic fixture in Kapso's
message shape; point `KAPSO_BASE_URL=http://localhost:8435` with
`KAPSO_API_KEY=test` and any phone number id at it.
