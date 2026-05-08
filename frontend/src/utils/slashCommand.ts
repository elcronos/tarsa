/**
 * Parse Claude Code slash-command metadata blocks that appear at the head of
 * a transcript when the user invoked the session via `/foo:bar arg arg`.
 *
 * Recognized tags:
 *   <command-message>NAME</command-message>
 *   <command-name>/NAME</command-name>
 *   <command-args>ARGS</command-args>
 */

export interface SlashCommand {
  /** e.g. "oh-my-claudecode:deep-interview" */
  name: string;
  /** Raw arg string after the command, may be empty */
  args: string;
  /** Remaining prompt text after stripping the meta block */
  rest: string;
}

const TAG_RE =
  /<command-(message|name|args)>([\s\S]*?)<\/command-\1>/gi;

export function parseSlashCommand(prompt: string): SlashCommand | null {
  if (!prompt || !prompt.includes("<command-")) return null;

  let name = "";
  let args = "";
  let firstIdx = -1;
  let lastEndIdx = -1;
  let m: RegExpExecArray | null;

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(prompt)) !== null) {
    if (firstIdx === -1) firstIdx = m.index;
    lastEndIdx = m.index + m[0].length;
    const tag = m[1]!.toLowerCase();
    const value = (m[2] ?? "").trim();
    if (tag === "name") {
      name = value.replace(/^\//, "");
    } else if (tag === "message" && !name) {
      name = value;
    } else if (tag === "args") {
      args = value;
    }
  }

  if (!name && !args) return null;

  // Strip the contiguous meta block from the prompt to expose any real body
  // that follows it.
  let rest = prompt;
  if (firstIdx !== -1 && lastEndIdx !== -1) {
    rest = (prompt.slice(0, firstIdx) + prompt.slice(lastEndIdx)).trim();
  }

  return { name, args, rest };
}
