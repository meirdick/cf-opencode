#!/usr/bin/env node
// Copy what `cf-opencode init` deploys (Worker source, wrangler config, workspace image) into cli/templates,
// so an npm install of the CLI can deploy without a checkout. Also copies README, LICENSE and NOTICE.
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(cli, "..");
const out = join(cli, "templates");
// Keep in sync with DEPLOY_FILES in src/init.ts.
const FILES = ["worker/src", "worker/wrangler.jsonc", "image"];

// `--plugin`: the plugin package only needs LICENSE and NOTICE beside its own README.
if (process.argv.includes("--plugin")) {
  for (const f of ["LICENSE", "NOTICE"]) await cp(join(root, f), join(root, "plugin", f));
  process.exit(0);
}

await rm(out, { recursive: true, force: true });
for (const f of FILES) {
  if (!existsSync(join(root, f))) {
    process.stderr.write(`Failed: ${f} not found — fix: run from a cf-opencode checkout\n`);
    process.exit(1);
  }
  await mkdir(dirname(join(out, f)), { recursive: true });
  await cp(join(root, f), join(out, f), {
    recursive: true,
    filter: (s) => !/\.test\.ts$|^node_modules$|^\.wrangler$/.test(basename(s)),
  });
}
for (const f of ["README.md", "LICENSE", "NOTICE"]) await cp(join(root, f), join(cli, f));
process.stderr.write(`sync-templates: wrote ${out}\n`);
