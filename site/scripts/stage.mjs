// Stage one assets folder for the cf-opencode-site Worker:
// landing page (site/public) at /, user docs (docs-site/dist) at /docs/.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(site, "public");
const docs = join(site, "..", "docs-site", "dist");
const out = join(site, ".deploy");

if (!existsSync(join(docs, "index.html"))) {
  console.error("Failed: docs-site/dist is missing. Run npm run build:docs first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(pub, out, { recursive: true });
cpSync(docs, join(out, "docs"), { recursive: true });

// Workers reads only the root _headers. Move the docs' rules under /docs, and
// drop the landing page's CSP there: it blocks the docs' theme script and search.
let headers = readFileSync(join(pub, "_headers"), "utf8");
headers += "\n# Docs\n/docs/*\n  ! Content-Security-Policy\n";
const docsHeaders = join(out, "docs", "_headers");
if (existsSync(docsHeaders)) {
  headers += `\n${readFileSync(docsHeaders, "utf8").replace(/^\/(?!docs(?:\/|$))/gm, "/docs/")}`;
  rmSync(docsHeaders);
}
writeFileSync(join(out, "_headers"), headers);

// page-view script on every docs page (the landing pages carry the tag in their own HTML)
for (const f of readdirSync(join(out, "docs"), { recursive: true })) {
  if (!String(f).endsWith(".html")) continue;
  const file = join(out, "docs", String(f));
  const html = readFileSync(file, "utf8");
  if (!html.includes("/t.js")) writeFileSync(file, html.replace("</body>", '<script src="/t.js" defer></script></body>'));
}

console.log("Staged site/.deploy: landing at /, docs at /docs/");
