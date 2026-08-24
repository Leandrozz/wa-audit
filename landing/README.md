# Landing

Static, single-file, no build step. Before publishing:

1. Replace the two placeholder URLs in `index.html` (marked with a comment at
   the top): the booking link (`cal.com/TU-USUARIO/...`) and the repo link
   (`github.com/TU-USUARIO/wa-audit`).
2. Deploy anywhere static: Vercel (`vercel landing`), GitHub Pages (serve the
   `landing/` folder), Netlify, or any web server.

Design notes: Fraunces + IBM Plex (Google Fonts); navy accent `#1F3864`
matches the report deliverable; light/dark via `prefers-color-scheme`.
Deliberately NO WhatsApp branding, logo or green — "WhatsApp" appears only as
nominative mention (see the trademark rationale in the main README).

The funnel: the hero's refuted-finding card is the product thesis; the two
CTAs self-segment the audience (SMEs → 30-minute meeting; developers → repo).
