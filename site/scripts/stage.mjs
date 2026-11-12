// Stage one assets folder for the cf-opencode-site Worker:
// landing page (site/public) at /, user docs (docs-site/dist) at /docs/.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

console.log("Staged site/.deploy: landing at /, docs at /docs/");
