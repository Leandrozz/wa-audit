# Issue seed — run once after publishing to GitHub

Known gaps, converted into public issues on purpose: they are contribution
surface and roadmap honesty, not embarrassment. With
[gh](https://cli.github.com/) authenticated, run from the repo root:

```bash
gh label create "good first issue" --color 7057ff --force
gh issue create -l "good first issue" -t "Add timeouts to all fetch calls" -b "No fetch in the pipeline uses AbortSignal.timeout. A WAHA instance that accepts the connection and never responds hangs the process; in threads.mjs the concurrency pool (6 workers) can be fully blocked by one hung endpoint. Suggested: AbortSignal.timeout(30_000) on every fetch in src/probe.mjs, src/export.mjs, src/threads.mjs (fetchRetry). src/lib/llm.mjs already does this."
gh issue create -l "good first issue" -t "TTL / --refresh-lids flag for the negative @lid cache" -b "threads.mjs caches failed @lid resolutions permanently in lid-cache.json. If WAHA was down during a run, those LIDs are marked unresolvable forever unless the user deletes the cache by hand. Suggested: store a timestamp per negative entry and re-try after a TTL, or add a --refresh-lids flag that re-queries only the negative entries."
gh issue create -l "good first issue" -t "Retry 429 with backoff in fetchRetry" -b "fetchRetry (src/threads.mjs) retries 5xx and network errors but treats 429 as a definitive 4xx. With concurrency 6 against hundreds of LID lookups, rate limiting produces false 'unresolved' results that then get negative-cached. Suggested: retry 429 honoring Retry-After with exponential backoff."
gh issue create -t "Freeze the export time window (filter.timestamp.lte)" -b "The messages offset in WAHA is global across the account. If messages arrive during a long dump, offsets shift and the export can duplicate or skip pages. Suggested: capture a cutoff timestamp when the export starts and pass filter.timestamp.lte=<cutoff> on every page request." -l bug
gh issue create -t "Make export resume robust against a truncated last line" -b "Resume counts lines in messages.jsonl. If the process died mid-append, the truncated last line is counted, the offset is off by one, and the corpus phase later counts it as malformed. Suggested: validate that the last line parses as JSON on resume; if not, drop it and adjust the offset. Also: alreadyDumped() reads the whole file into memory — count in streaming for very large dumps." -l bug
gh issue create -t "Configurable CSV delimiter for messages.csv" -b "messages.csv uses commas. Excel under es-AR (and most European) locales expects semicolons and opens the file as a single column, BOM notwithstanding. Suggested: output.csvDelimiter config defaulting per locale." -l enhancement
gh issue create -t "i18n for the report prose (the data contract is already English)" -b "The XLSX report prose is Spanish (es-AR preset). The contract underneath is English, so this is presentation-layer work: extract the prose of src/report-xlsx.mjs into a language bundle and add an en bundle. Sheet names and column labels included." -l enhancement
gh issue create -t "First-class anonymization flag (hash numbers, redact names)" -b "A privacy.anonymize mode that hashes phone numbers, redacts contact names, and optionally drops message text would let users share corpora and demo the tool on real data. It is also the strongest answer to the SME question 'what about my data?'. Design note: anonymize at the threads.mjs output layer, keep the raw dump untouched." -l enhancement
gh issue create -t "Support the WhatsApp .txt chat export as an input (no WAHA needed)" -b "The manual 'export chat' .txt covers one chat at a time but requires zero infrastructure, which multiplies the audience. The corpus contract stays the same; only a new parser phase is needed. Every OSS analyzer in this category consumes .txt — for us it is an entry ramp toward the full WAHA flow." -l enhancement
gh issue create -t "Channel-aware report prose pass for Instagram corpora" -b "The IG lane sets summary.channel and the report titles/origin sentences already follow it, but the XLSX methodology sheet still explains @lid/@c.us resolution mechanics even when the corpus is 100% Instagram, where none of that applies (the 'Nombre (WAHA o CRM)' column header included). Suggested: thread canal through the rest of the methodology and CRM sections too, so an IG report never mentions WhatsApp-only concepts." -l enhancement
gh issue create -t "CRM matching for Instagram threads" -b "matchCrm keys off the normalized phone number; @ig threads carry phone: null by design (an IG user id is not a phone number), so IG corpora never get a CRM join today. Suggested: a second match path keyed on IG username so IG threads can carry the same crm block WhatsApp threads do." -l enhancement
gh issue create -t "Lower the IG export throttle floor for non-instagram.com bases" -b "THROTTLE_MS in export-ig.mjs is a hard 3000ms floor on every request, real or mocked, which is what keeps requests to instagram.com at human pace. It also makes every throttled exporter test cost 5-25s in CI, where the risk the floor guards against does not exist. Suggested: gate a lower floor behind IG_BASE_URL not being instagram.com, so the safety property holds for the only case it actually protects." -l enhancement
```

Also after publishing:

- Add the CI badge to both READMEs:
  `![CI](https://github.com/<owner>/wa-audit/actions/workflows/ci.yml/badge.svg)`
- Open a PR to `devlikeapro/waha-docs` to appear in WAHA's community
  Integrations list — free distribution to the exact target audience.
- Tag `v0.1.0` is created locally by the release commit; push it with
  `git push --tags`.
