# cf-opencode site

The landing page. A static site on a Cloudflare Worker (static assets, no Worker script). The same Worker serves the user docs from `../docs-site` at `/docs/`.

- `public/`: the landing page. Plain HTML and CSS; `app.js` is the copy button only.
- `scripts/stage.mjs`: copies `public/` and `../docs-site/dist` into `.deploy/`.
- `npm run deploy`: builds the docs, stages, and deploys the Worker `cf-opencode-site`.

Rules for the page:

- Every claim must be true for the released version. Check it against the README and the source.
- No number that was not measured. The day timeline is labelled as an example.
- `index.html` has `noindex` until launch.
- Fonts are self-hosted (SIL Open Font License, see `public/fonts/`). The CSP allows no other origin and no inline style or script.
