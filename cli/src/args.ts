// Minimal flag parser. Enough for this CLI; not a general one.
export interface FlagSpec {
  [name: string]: { type: "boolean" | "string"; short?: string };
}

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
  const shorts = new Map<string, string>();
  for (const [name, f] of Object.entries(spec)) if (f.short) shorts.set(f.short, name);
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("-")) {
      positionals.push(a);
      continue;
    }
    const body = a.replace(/^-+/, "");
    const eq = body.indexOf("=");
    const raw = eq >= 0 ? body.slice(0, eq) : body;
    const name = shorts.get(raw) ?? raw;
    const flag = spec[name];
    if (!flag) throw new Error(`unknown flag --${raw}`);
    if (flag.type === "boolean") {
      flags[name] = true;
      continue;
    }
    const value = eq >= 0 ? body.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = value;
  }
  return { flags, positionals };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}
