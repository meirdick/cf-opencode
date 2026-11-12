export class CliError extends Error {
  readonly fix: string;
  constructor(cause: string, fix: string) {
    // A Worker error is already a whole "Failed: … — fix: …" line; do not wrap it twice.
    super(cause.startsWith("Failed:") ? cause : `Failed: ${cause} — fix: ${fix}`);
    this.fix = fix;
  }
}

export function toFailedLine(e: unknown): string {
  if (e instanceof CliError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith("Failed:") ? m : `Failed: ${m} — fix: rerun with --help`;
}
