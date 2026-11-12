// Output: progress to stderr, results to stdout, so `--json` stdout is one JSON document.
export interface Ui {
  json: boolean;
  /** Progress line (stderr). */
  step(line: string): void;
  /** Result text (stdout). Suppressed with --json. */
  out(line: string): void;
  /** The JSON result (stdout). Only with --json. */
  result(value: unknown): void;
}

export function makeUi(json: boolean): Ui {
  return {
    json,
    step: (l) => process.stderr.write(`${l}\n`),
    out: (l) => {
      if (!json) process.stdout.write(`${l}\n`);
    },
    result: (v) => {
      if (json) process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    },
  };
}

/** Plain text table, columns sized to content. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

export function fmtAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  const s = Math.round((t - now) / 1000);
  const a = Math.abs(s);
  // The Worker's clock and this one differ by a second or two. "in 1s" for a past event reads wrong.
  if (a < 5) return "now";
  const v =
    a < 120
      ? `${a}s`
      : a < 7200
        ? `${Math.round(a / 60)}m`
        : a < 172_800
          ? `${Math.round(a / 3600)}h`
          : `${Math.round(a / 86_400)}d`;
  return s < 0 ? `${v} ago` : `in ${v}`;
}

/** Ask on the terminal. Returns the trimmed answer. */
export async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Read a secret: one line from a pipe, or typed on the terminal without echo. Ctrl-C aborts. */
export async function readSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) data += chunk;
    return data.trim().split(/\r?\n/)[0]?.trim() ?? "";
  }
  process.stderr.write(question);
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(buf.trim());
          return;
        }
        if (ch === "\u0003") {
          done();
          reject(new Error("Failed: cancelled — fix: run the command again"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
