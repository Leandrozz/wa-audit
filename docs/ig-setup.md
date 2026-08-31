# Instagram DMs — export your own inbox

`npm run export:ig` reads **your own** Instagram DM inbox through the same
private web API the official instagram.com client uses, and emits the exact
`messages.jsonl` the rest of the pipeline consumes. From there everything is
identical: `threads` → analysis → verified report, now labeled Instagram.

## Read this first (risk, honestly)

Like the WAHA lane, this is an **unofficial client** and it is against
Instagram's terms. The design keeps the risk profile as low as it goes —
login happens in your real browser (the tool never sees a password), the
exporter only reads, it waits ≥3 s between requests, and it stops dead the
moment Instagram raises a checkpoint instead of retrying — but the risk is
not zero and Instagram is far more trigger-happy than WhatsApp.

- **First run on a test account, never on a client's.**
- The zero-risk alternative exists: Instagram → Accounts Center →
  "Download your information" gives you every DM as JSON, officially. It
  just takes hours to days. If you are not in a hurry, use that.

## Setup (2 minutes)

1. Log into instagram.com in your browser as usual.
2. DevTools → Application → Cookies → copy `sessionid` and `ds_user_id`.
3. `cp ig.env.example ig.env`, paste both values (gitignored, never commit).
4. Point the output somewhere IG-only, so channels never mix:

```bash
set -a; . ./ig.env; set +a
WA_OUT_DIR=data/ig-history npm run export:ig
WA_OUT_DIR=data/ig-history node src/threads.mjs --session ig --no-net
```

`--since 365` bounds the pull to the last year. The export is resumable: a
rerun skips completed conversations.

One guardrail on that resume: a rerun whose window reaches further back than
the saved state does refuses before it makes a single request. Say the first
run used `--since 365` and the rerun drops `--since` entirely (full history)
— resuming would mark threads "done" without ever fetching the older messages
in that gap, a silent data loss, so it stops loudly instead. Rerun with the
same (or a narrower) `--since` that produced the saved state, or delete
`ig-export-state.json` and `messages.jsonl` in the output dir for a fresh
full export.

## If Instagram interrupts the run

The exporter saves its state and tells you. Do not rerun immediately: open
instagram.com, complete any verification, wait a few hours, refresh the two
cookies in `ig.env`, rerun. It resumes where it stopped.

## What lands in the corpus

1:1 conversations only (group DMs are skipped and counted). Identity is the
numeric IG user id (`ig:<id>` threads — usernames change, ids don't), the
username shows as the contact name, and no phone-based CRM matching applies
to IG threads in v1.
