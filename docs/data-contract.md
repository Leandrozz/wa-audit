# Data contract v1

Three versioned files connect the pipeline phases. All carry
`"schema_version": 1`; a consumer must reject other versions loudly.
Keys and enums are English (the contract); labels and report prose may be any
language (presentation).

## threads.json — the corpus

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-08-24T12:00:00.000Z",
  "session": "my-session",
  "threads": [
    {
      "thread_id": "5491155501234",      // phone without '+', or "lid_<id>" if unresolved
      "phone": "+5491155501234",          // canonical E.164, or null
      "phone_display": "+54 9 11 5550 1234",
      "jids": ["5491155501234@c.us", "200000000000001@lid"],  // all JIDs merged into this thread
      "contact_name": "Ana Gómez",        // from WAHA contacts or pushName, or null
      "unresolved_lid": false,            // true = the "phone" may not be real
      "is_system": false,                 // 0@c.us, status@broadcast
      "is_internal": false,               // own line of the business
      "crm": {                            // matched CRM row, or null
        "name": "...", "contact": "...", "phone": "...", "whatsapp": "...",
        "email": "...", "segment": "...", "stage": "...", "location": "..."
      },
      "metrics": {
        "total": 8, "inbound": 5, "outbound": 3, "with_media": 1,
        "first_message": "2026-05-04T10:02:00.000-03:00",
        "last_message": "2026-06-11T07:40:00.000-03:00",
        "duration_days": 38.1,
        "responses_measured": 3,
        "median_response_min": 7.5,       // null if never answered
        "unanswered": false,              // last message is the client's
        "top_time_slot": "morning",       // early_morning | morning | afternoon | evening
        "peak_hour": 10,                  // 0-23, local time
        "two_way": true
      },
      "messages": [
        {
          "ts": 1746367320,               // unix seconds (as WAHA delivers)
          "iso": "2026-05-04T10:02:00.000-03:00",  // local time, configured offset
          "direction": "inbound",         // inbound | outbound
          "type": "text",                 // text | image | video | audio | voice_note |
                                          // document | sticker | contact | location |
                                          // buttons | media
          "text": "Hola! ...",
          "has_media": false
        }
      ]
    }
  ]
}
```

**Semantics that matter:**

- `median_response_min` is measured **per inbound burst**: for each run of
  consecutive inbound messages, the time until the *first* outbound reply,
  anchored at the *first* message of the burst. Bursts with no reply don't
  count (no zero, no infinity).
- An unresolved `@lid` gets its own thread and `unresolved_lid: true` —
  **never an invented phone number.**
- `outbound` does not distinguish humans from bots; the dump can't.

## summary.json — run counters

Flat object, all counters computed while building the corpus:
`lines_read`, `group_messages_excluded`, `malformed_messages`,
`messages_without_sender`, `messages_included`, `one_to_one_chats`,
`lid_jids`, `cus_jids`, `other_jids`, `lids_resolved`, `lids_unresolved`,
`lid_cus_merges`, `multi_jid_threads`, `threads`, `two_way_threads`,
`unanswered_threads`, `threads_with_contact_name`, `crm_available`,
`crm_matches`, `internal_threads`, `inbound`, `outbound`,
`messages_with_media`, `global_median_response_min`, `count_check_ok`,
`duplicate_thread_ids`, `warnings[]`.

`count_check_ok` asserts
`messages_included + group + malformed + no-sender == lines_read`.
`warnings` travels into the report's methodology sheet — anomalies must reach
the person reading the deliverable.

## analysis.json — verified analysis

Formalized in [`../analysis/analysis.schema.json`](../analysis/analysis.schema.json);
validate with `npm run check:analysis`. Key design decision: **`verdict` is
required** — a dimension without a recorded verification pass is invalid.
A complete example: [`../fixtures/analysis-sample.json`](../fixtures/analysis-sample.json).

Any engine that emits a valid file is a first-class analysis engine — the
built-in `src/analyze.mjs` is just one implementation
(see [`../analysis/PLAYBOOK.md`](../analysis/PLAYBOOK.md)).

## CRM CSV input

Header row required; recognized columns (any order, extras ignored):
`phone` (required), `whatsapp`, `name`, `contact`, `email`, `segment`,
`stage`, `location`. Matching = canonical E.164 exact, then last-10-digit
suffix fallback. Phone parsing uses `phone.defaultCountry` for numbers typed
without a country prefix.

## Spanish → English mapping (contract v0 → v1)

The original private pipeline used Spanish keys. If you ever need to migrate
an old corpus, this is the map (a migration script is deliberately not
shipped — YAGNI):

| v0 (Spanish) | v1 (English) |
|---|---|
| `conv_id` | `thread_id` |
| `numero` / `numero_display` | `phone` / `phone_display` |
| `nombre_waha` | `contact_name` |
| `lid_sin_resolver` | `unresolved_lid` |
| `es_sistema` / `es_interno` | `is_system` / `is_internal` |
| `metricas` | `metrics` |
| `entrantes` / `salientes` | `inbound` / `outbound` |
| `direccion: entrante/saliente` | `direction: inbound/outbound` |
| `tipo: nota_de_voz, imagen, …` | `type: voice_note, image, …` |
| `'madrugada (00-05)'` … | `early_morning` … (labels are presentation) |
| `sin_responder` / `ida_y_vuelta` | `unanswered` / `two_way` |
| `fecha_iso` / `texto` / `tiene_media` | `iso` / `text` / `has_media` |
| `hallazgos` / `verdicto` / `refutados` | `findings` / `verdict` / `refuted` |
| `columnas_xlsx` + label-keyed `filas_xlsx` | `columns[{key,label}]` + key-keyed `rows` |
