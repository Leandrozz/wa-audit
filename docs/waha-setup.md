# WAHA setup — the traps, prepaid

Everything below was paid for in real debugging time. Read it before your
first export.

## Engine: NOWEB (or GOWS). Not WEBJS.

The bulk-history endpoint this pipeline lives on —
`GET /api/{session}/chats/all/messages` — **only exists on the NOWEB and GOWS
engines**. On WEBJS it fails and you'd have to crawl chat by chat (not
supported here). `src/probe.mjs` detects this and tells you before you waste
time.

## History depth: fullSync must exist BEFORE the history does

By default a fresh session syncs roughly **~3 months** of history. If you need
more, the session must be **created** with:

```json
{ "config": { "noweb": { "store": { "enabled": true, "fullSync": true } } } }
```

Enabling it later does not backfill. The probe measures the real depth with
`filter.timestamp.lte` probes (30/90/180/270/365/550 days) so you know what
you actually have before dumping.

## The dump occupies a linked-device slot

A WAHA session counts against WhatsApp's linked-devices limit. When you're
done exporting, free it — `src/export.mjs` prints the exact command:

```bash
curl -X DELETE -H "X-Api-Key: $WAHA_API_KEY" $WAHA_BASE_URL/api/sessions/<session>
```

## Pagination lies (in both directions)

- A **short or empty page does not mean the end** of the messages listing.
  `src/export.mjs` only stops after **3 consecutive empty pages**.
- The offset is global across the whole account. If messages arrive during a
  long dump, offsets shift — the safest run is during off-hours. (A frozen
  time-window via `filter.timestamp.lte` at export start is on the roadmap.)

## @lid — the expensive trap

WhatsApp identifies many contacts with an opaque `@lid` JID instead of the
phone number (in the original corpus: 405 of 612 chats). Without resolving
them, the same person shows up as two conversations and never matches your
CRM. Resolution goes through `/api/{s}/lids/{lid}` + `/api/contacts`, with an
on-disk cache (`lid-cache.json`) because it's hundreds of requests. LIDs that
don't resolve keep their own thread flagged `unresolved_lid` — a number is
never invented.

Note: a negative resolution is cached permanently. If WAHA was down during the
run, delete `lid-cache.json` and re-run (a TTL/`--refresh-lids` flag is on the
roadmap).

## downloadMedia=false

The dump deliberately skips media downloads. Consequences: `media` comes back
null and the real message type lives in `_data.message.*` (the corpus phase
handles this); photos, voice notes and documents have **no analyzable
content**, just a type.

## Pseudo-contacts

`0@c.us` and `status@broadcast` are WhatsApp system pseudo-contacts, not
clients. The corpus flags them `is_system: true` and the report excludes them
from client counts.

## pushName is almost always empty

Contact names come from `/api/contacts`, not from message `pushName` (which
this pipeline still uses as a fallback when present).
