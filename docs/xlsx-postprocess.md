# The XLSX post-processing — documented black magic

`xlsx@0.18.5` (SheetJS community edition) writes neither **cell styles** nor
**frozen panes** — those are Pro features. Instead of taking a heavier
dependency, `src/report-xlsx.mjs` generates the workbook with SheetJS and then
post-processes the `.xlsx` **as a ZIP** using `cfb` (which SheetJS itself
depends on):

1. Replace `/xl/styles.xml` wholesale with a hand-written stylesheet
   (4 styles: normal, header ─ white bold on dark blue, wrapped body, title).
2. For each sheet, rewrite `sheetN.xml`:
   - inject `<pane state="frozen">` into `<sheetViews>` for frozen header rows;
   - add `s="N"` style attributes to `<c>` cells row by row, via regex.

## Why `bookSST: true` is LOAD-BEARING

The workbook is written with `bookSST: true` (shared strings table). This is
not just a size optimization (though it helps a lot — quotation templates
repeat): **it is what makes the regex rewrite safe.** With SST, all user text
lives in `sharedStrings.xml` and the sheet XML contains only numeric indexes.
With `bookSST: false`, arbitrary message text — which can legitimately contain
`</row>` or `<c ` — would land inside `sheetN.xml` and corrupt the regex
rewrite. The synthetic fixture includes exactly such a hostile message to keep
this honest. **Do not flip `bookSST`.**

## Known assumptions (fine today, checked by tests)

- SheetJS community 0.18.5 does not emit `s=` attributes itself (so blindly
  adding `s="N"` can't produce a duplicate attribute). That's why the
  dependency is **pinned** to 0.18.5.
- `wb.SheetNames` order maps to `sheet1.xml..sheetN.xml` — true for this
  SheetJS version, not guaranteed by the OOXML spec.
- The styles replacement is total, not additive: any `numFmt` SheetJS wrote is
  discarded. Fine while all dates are strings; if real date cells are ever
  introduced, this must be revisited.
- If SheetJS ever omitted `<sheetViews>`, the frozen-pane injection would
  silently not match. The test suite asserts `state="frozen"` is present in
  the output ZIP, so a regression fails CI instead of shipping.

## Other Excel hard limits handled here

- **32,767 chars per cell**: longer text is truncated and marked
  `[…TRUNCADO]`; the methodology sheet reports how many cells were truncated.
- **Control characters** (`\x00-\x08\x0B\x0C\x0E-\x1F`) are stripped —
  they make Excel refuse to open the file.
- **Sheet names**: ≤31 chars, no `: \ / ? * [ ]`, deduplicated with ` (2)`
  suffixes.
- The script re-reads the finished file and exits 1 if row counts don't match
  the corpus — the post-processing can't silently corrupt the deliverable.
