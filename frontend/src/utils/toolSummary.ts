// toolSummary.ts — Rule-based plain-language summaries for tool calls.
//
// An optional PostToolUse hook calling an LLM could enrich tool calls with
// summaries written to /tmp/agentscope.jsonl alongside tool_response.
// Pros: high-quality natural language.
// Cons: latency, cost, hook output may not be reliably captured.
// For now use rule-based mapper above.

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function summarizeTool(tool_name: string, input: unknown): string {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  switch (tool_name) {
    case "Read": {
      const fp = str(inp["file_path"] ?? inp["filePath"] ?? inp["path"]);
      return fp ? `Reading ${fp}` : "Reading file";
    }
    case "Write": {
      const fp = str(inp["file_path"] ?? inp["filePath"] ?? inp["path"]);
      return fp ? `Writing ${fp}` : "Writing file";
    }
    case "Edit": {
      const fp = str(inp["file_path"] ?? inp["filePath"] ?? inp["path"]);
      return fp ? `Editing ${fp}` : "Editing file";
    }
    case "MultiEdit": {
      const fp = str(inp["file_path"] ?? inp["filePath"] ?? inp["path"]);
      const edits = Array.isArray(inp["edits"]) ? inp["edits"] : [];
      const suffix = edits.length > 0 ? ` (${edits.length} hunks)` : "";
      return fp ? `Editing ${fp}${suffix}` : `Editing file${suffix}`;
    }
    case "NotebookEdit": {
      const fp = str(inp["notebook_path"] ?? inp["file_path"] ?? inp["filePath"] ?? inp["path"]);
      return fp ? `Editing ${fp}` : "Editing notebook";
    }
    case "Bash": {
      const desc = str(inp["description"]);
      if (desc) return `Running: ${desc}`;
      const cmd = str(inp["command"]);
      return cmd ? `Running: ${truncate(cmd, 60)}` : "Running command";
    }
    case "Grep": {
      const pattern = str(inp["pattern"] ?? inp["query"]);
      const path = str(inp["path"] ?? inp["include"]);
      if (pattern && path) return `Searching for '${pattern}' in ${path}`;
      if (pattern) return `Searching for '${pattern}'`;
      return "Searching files";
    }
    case "Glob": {
      const pattern = str(inp["pattern"] ?? inp["glob"]);
      return pattern ? `Finding files matching ${pattern}` : "Finding files";
    }
    case "WebFetch": {
      const url = str(inp["url"]);
      return url ? `Fetching ${url}` : "Fetching URL";
    }
    case "WebSearch": {
      const query = str(inp["query"] ?? inp["q"]);
      return query ? `Searching web: ${query}` : "Searching the web";
    }
    case "Task":
    case "Agent": {
      const subtype = str(inp["subagent_type"] ?? inp["type"]);
      const desc = str(inp["description"] ?? inp["prompt"]);
      if (subtype && desc) return `Spawning ${subtype}: ${truncate(desc, 60)}`;
      if (subtype) return `Spawning ${subtype}`;
      if (desc) return `Spawning agent: ${truncate(desc, 60)}`;
      return "Spawning agent";
    }
    case "TodoWrite": {
      const todos = Array.isArray(inp["todos"]) ? inp["todos"] : [];
      return todos.length > 0 ? `Updating todos (${todos.length} items)` : "Updating todos";
    }
    default: {
      // Fall back to first meaningful candidate field
      const candidates = [
        "description",
        "command",
        "file_path",
        "filePath",
        "path",
        "pattern",
        "query",
        "url",
        "old_string",
        "prompt",
      ] as const;
      for (const k of candidates) {
        const v = inp[k];
        if (typeof v === "string" && v.trim()) {
          return `${tool_name}: ${truncate(v.trim(), 80)}`;
        }
      }
      return tool_name;
    }
  }
}
