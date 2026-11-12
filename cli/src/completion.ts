// `cf-opencode completion <shell>`: tab completion for commands, flags and workspace ids.
// The script asks the CLI for the words (`cf-opencode __complete …`), so it stays correct after an upgrade.
import { CliError } from "./errors.js";

export interface CompletionCommand {
  name: string;
  flags: string[];
  /** True when the first argument is a workspace id. */
  workspace: boolean;
}

export const SHELLS = ["bash", "zsh", "fish"] as const;

/**
 * Words for the cursor position. `words` is the command line after `cf-opencode`, the last entry being
 * the word under the cursor (possibly empty).
 */
export function completeWords(
  words: string[],
  commands: CompletionCommand[],
  globalFlags: string[],
  workspaces: () => string[],
): string[] {
  const current = words[words.length - 1] ?? "";
  const before = words.slice(0, -1);
  const name = before.find((w) => !w.startsWith("-"));
  const cmd = commands.find((c) => c.name === name);
  let pool: string[];
  if (!cmd) pool = current.startsWith("-") ? globalFlags : commands.map((c) => c.name);
  else if (current.startsWith("-")) pool = [...cmd.flags, ...globalFlags];
  else if (cmd.name === "completion") pool = [...SHELLS];
  else if (cmd.workspace && before.filter((w) => !w.startsWith("-")).length === 1) pool = workspaces();
  else pool = [];
  return [...new Set(pool)].filter((w) => w.startsWith(current)).sort();
}

export function completionScript(shell: string): string {
  if (shell === "bash")
    return `# cf-opencode completion for bash. Add to ~/.bashrc:  eval "$(cf-opencode completion bash)"
_cf_opencode() {
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  local IFS=$'\\n'
  COMPREPLY=($(cf-opencode __complete -- "\${words[@]}" 2>/dev/null))
}
complete -F _cf_opencode cf-opencode
`;
  if (shell === "zsh")
    return `# cf-opencode completion for zsh. Add to ~/.zshrc:  eval "$(cf-opencode completion zsh)"
_cf_opencode() {
  local -a reply_words
  reply_words=("\${(@f)$(cf-opencode __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  compadd -a reply_words
}
compdef _cf_opencode cf-opencode
`;
  if (shell === "fish")
    return `# cf-opencode completion for fish. Save as ~/.config/fish/completions/cf-opencode.fish
complete -c cf-opencode -f -a '(cf-opencode __complete -- (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'
`;
  throw new CliError(`no completion for ${JSON.stringify(shell)}`, `use one of: ${SHELLS.join(", ")}`);
}
