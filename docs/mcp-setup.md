# MCP setup — let Claude (or any MCP client) run the audit

`npm run mcp` starts a stdio MCP server that turns any MCP-capable agent —
Claude Desktop, Claude Code, ChatGPT (developer mode), Cursor — into the
analysis engine. The agent interviews the operator, guides the WAHA setup,
shows the pairing QR in chat, exports the history, reads the corpus, and
performs the analysis dimension by dimension.

What the server enforces (this is the point):

- **`submit_dimension` rejects any dimension without a verdict** — the
  contract requires a recorded verification pass (in the original run, 34 of
  60 findings were refuted; unverified LLM analysis is fiction).
- **Every evidence quote is re-checked server-side** against the corpus —
  fabricated evidence cannot be submitted even if the agent skips
  `verify_quote`.
- Chat content is served under an **untrusted-data banner**: customer messages
  are analyzed, never obeyed.
- The server **never sends WhatsApp messages**. Toward WhatsApp it is
  read-only except creating the WAHA session during onboarding.

## Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "wa-audit": {
      "command": "node",
      "args": ["C:/path/to/wa-audit/src/mcp-server.mjs"],
      "env": {
        "WAHA_BASE_URL": "http://localhost:3000",
        "WAHA_API_KEY": "change-this-key",
        "WA_OUT_DIR": "C:/path/to/wa-audit/data/wa-history",
        "WA_BUSINESS_NAME": "My Business"
      }
    }
  }
}
```

Claude Code: `claude mcp add wa-audit -e WAHA_BASE_URL=... -e WAHA_API_KEY=... -- node /path/to/wa-audit/src/mcp-server.mjs`

Then just ask: *"Auditá mi WhatsApp comercial"* — the server's instructions
walk the agent through the whole flow (`status` tells it where it stands).

## Tools

| Tool | What it does |
|---|---|
| `status` | WAHA reachability, files present, suggested next step |
| `waha_setup_guide` / `waha_create_session` / `waha_qr` | Docker guide, session with `fullSync`, pairing QR as an inline image |
| `save_business_context` | Stores the operator interview (feeds analysis + verifier) |
| `run_probe` / `run_export` / `build_corpus` | The pipeline phases 0/2/3 |
| `corpus_stats` | Deterministic numbers (they win every conflict) |
| `read_threads` | Conversation content, paginated, untrusted-data banner |
| `list_dimensions` / `get_dimension_prompt` | The commercial + FATE dimension sets |
| `verify_quote` | Layer-A evidence check, server-side |
| `submit_dimension` | Contract-validated upsert (verdict mandatory) |
| `render_report` | XLSX / HTML / DOCX, only from a valid verified analysis |

## Try it without WhatsApp

Run the mock WAHA (`node fixtures/mock-waha.mjs 8321`), generate fixtures
(`node fixtures/generate.mjs`), and configure the server with
`WAHA_BASE_URL=http://localhost:8321` plus a scratch `WA_OUT_DIR`. The whole
flow works — QR included — against synthetic data.
