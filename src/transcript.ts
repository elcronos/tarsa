/**
 * Claude Code transcript reader.
 *
 * Transcript files live at:
 *   ~/.claude/projects/<url-encoded-cwd>/<session-id>.jsonl
 *
 * Each line is a JSON object with a `type` field:
 *   "system" | "user" | "assistant" | "tool" | "tool_result"
 *
 * Falls back to [] if no transcript file is found.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type MessageType = "system" | "user" | "assistant" | "tool" | "tool_result" | "summary";

export interface TranscriptMessage {
  type: MessageType | string;
  content: string;
  ts: number;
  role?: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
  total_cost_usd?: number;
}

export interface SessionTokens {
  session_total: TokenUsage;
  per_agent: Record<string, TokenUsage>;
}

// ── In-memory cache ────────────────────────────────────────────────────────

interface CacheEntry {
  tokens: SessionTokens;
  mtime: number;
  cachedAt: number;
}

const TOKEN_CACHE = new Map<string, CacheEntry>();
const TOKEN_CACHE_TTL_MS = 30_000; // 30s

// ── Path resolution ────────────────────────────────────────────────────────

function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Find a transcript file for the given session id.
 * Claude encodes the cwd as a URL-encoded path component (slashes → %2F etc.)
 * We search all project dirs for a file named <sessionId>.jsonl.
 */
function findTranscriptPath(sessionId: string): string | null {
  // Reject session ids containing path traversal characters
  if (/[/\\]|\.\./.test(sessionId)) return null;

  const projectsDir = claudeProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;

  try {
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(projectsDir, d.name));

    for (const dir of projectDirs) {
      const candidate = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore permission errors
  }

  return null;
}

// ── JSONL parsing ──────────────────────────────────────────────────────────

function extractContent(obj: Record<string, unknown>): string {
  // Claude Code transcripts nest content under .message.content; fall back to
  // top-level .content for older formats.
  const messageObj = obj["message"] as Record<string, unknown> | undefined;
  const content = messageObj?.["content"] ?? obj["content"];

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const co = c as Record<string, unknown>;
          if (co["type"] === "text" && typeof co["text"] === "string") return co["text"];
          if (co["type"] === "tool_use") {
            const name = String(co["name"] ?? "tool");
            const input = co["input"] ? JSON.stringify(co["input"], null, 2) : "";
            return `[tool_use: ${name}]\n${input}`;
          }
          if (co["type"] === "tool_result") {
            const inner = co["content"];
            if (typeof inner === "string") return `[tool_result] ${inner}`;
            if (Array.isArray(inner)) {
              return (
                "[tool_result] " +
                inner
                  .map((b: unknown) => {
                    if (b && typeof b === "object") {
                      const bo = b as Record<string, unknown>;
                      if (typeof bo["text"] === "string") return bo["text"];
                    }
                    return "";
                  })
                  .filter(Boolean)
                  .join("\n")
              );
            }
            return `[tool_result] ${JSON.stringify(inner)}`;
          }
          if (co["type"] === "thinking" && typeof co["thinking"] === "string") {
            return `[thinking] ${co["thinking"]}`;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function parseMessageType(obj: Record<string, unknown>): MessageType | string {
  // Prefer the nested message.role (Claude Code transcripts) → fall back to
  // top-level type ("user"/"assistant") → top-level role.
  const messageObj = obj["message"] as Record<string, unknown> | undefined;
  if (messageObj && typeof messageObj["role"] === "string") {
    return messageObj["role"] as string;
  }
  const t = obj["type"];
  const role = obj["role"];
  if (typeof role === "string") return role;
  if (typeof t === "string") return t;
  return "unknown";
}

// ── Public API ─────────────────────────────────────────────────────────────

// ── Token usage reader ────────────────────────────────────────────────────

function emptyUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 0 };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read: a.cache_read + b.cache_read,
    cache_creation: a.cache_creation + b.cache_creation,
  };
}

/**
 * Read real token usage from a Claude Code transcript file.
 * Parses assistant-type messages and sums usage fields.
 *
 * When agentId is provided, filters by message metadata (agentId field in the
 * JSONL line). If the field is absent, falls back to session-level totals.
 *
 * Results are cached in-memory keyed by `${filePath}:${mtime}`, TTL 30s.
 */
export function readAgentTokens(sessionId: string, agentId?: string): TokenUsage {
  const filePath = findTranscriptPath(sessionId);
  if (!filePath) return emptyUsage();

  let mtime = 0;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return emptyUsage();
  }

  const cacheKey = `${filePath}:${mtime}`;
  const now = Date.now();
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && now - cached.cachedAt < TOKEN_CACHE_TTL_MS) {
    if (agentId != null) {
      return cached.tokens.per_agent[agentId] ?? emptyUsage();
    }
    return cached.tokens.session_total;
  }

  // Parse the file
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return emptyUsage();
  }

  const session_total = emptyUsage();
  const per_agent: Record<string, TokenUsage> = {};

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      // Only assistant messages have usage
      const role = obj["role"] ?? obj["type"];
      if (role !== "assistant") continue;

      const msg = obj["message"] as Record<string, unknown> | undefined;
      const usageRaw = (msg?.["usage"] ?? obj["usage"]) as Record<string, unknown> | undefined;
      if (!usageRaw) continue;

      const u: TokenUsage = {
        input_tokens: typeof usageRaw["input_tokens"] === "number" ? usageRaw["input_tokens"] : 0,
        output_tokens: typeof usageRaw["output_tokens"] === "number" ? usageRaw["output_tokens"] : 0,
        cache_read: typeof usageRaw["cache_read_input_tokens"] === "number" ? usageRaw["cache_read_input_tokens"] : 0,
        cache_creation: typeof usageRaw["cache_creation_input_tokens"] === "number" ? usageRaw["cache_creation_input_tokens"] : 0,
      };

      // Accumulate session total
      const st = session_total;
      st.input_tokens += u.input_tokens;
      st.output_tokens += u.output_tokens;
      st.cache_read += u.cache_read;
      st.cache_creation += u.cache_creation;

      // Per-agent accumulation using agentId field if present
      const lineAgentId = typeof obj["agentId"] === "string" ? obj["agentId"] : null;
      if (lineAgentId) {
        const existing = per_agent[lineAgentId] ?? emptyUsage();
        per_agent[lineAgentId] = addUsage(existing, u);
      }
    } catch {
      // skip malformed lines
    }
  }

  const tokens: SessionTokens = { session_total, per_agent };
  TOKEN_CACHE.set(cacheKey, { tokens, mtime, cachedAt: now });

  if (agentId != null) {
    return per_agent[agentId] ?? emptyUsage();
  }
  return session_total;
}

/** Read transcript directly from an absolute file path (used for subagent transcripts). */
export function readTranscriptByPath(filePath: string): TranscriptMessage[] {
  if (!filePath || filePath.includes("..")) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const type = parseMessageType(obj);
      const content = extractContent(obj);
      const tsField = obj["ts"] ?? obj["timestamp"] ?? obj["created_at"];
      const ts =
        typeof tsField === "number"
          ? tsField
          : typeof tsField === "string"
            ? new Date(tsField).getTime() || Date.now()
            : Date.now();
      messages.push({
        type,
        content,
        ts,
        role: typeof obj["role"] === "string" ? obj["role"] : undefined,
      });
    } catch {
      // skip malformed
    }
  }
  return messages;
}

/** Returns the first user message content from a transcript file, or null. */
export function firstUserMessage(filePath: string): string | null {
  const msgs = readTranscriptByPath(filePath);
  for (const m of msgs) {
    if (m.type === "user" && m.content.trim()) return m.content;
  }
  return null;
}

/** Returns the last assistant message content from a transcript file, or null. */
export function lastAssistantMessage(filePath: string): string | null {
  const msgs = readTranscriptByPath(filePath);
  let last: string | null = null;
  for (const m of msgs) {
    if ((m.type === "assistant" || m.role === "assistant") && m.content.trim()) {
      last = m.content;
    }
  }
  return last;
}

export async function readTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  const filePath = findTranscriptPath(sessionId);
  if (!filePath) return [];

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const messages: TranscriptMessage[] = [];
  const lines = raw.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const type = parseMessageType(obj);
      const content = extractContent(obj);
      // Timestamp: prefer ts/timestamp fields, fall back to Date.now
      const tsField = obj["ts"] ?? obj["timestamp"] ?? obj["created_at"];
      const ts =
        typeof tsField === "number"
          ? tsField
          : typeof tsField === "string"
            ? new Date(tsField).getTime() || Date.now()
            : Date.now();

      messages.push({
        type,
        content,
        ts,
        role: typeof obj["role"] === "string" ? obj["role"] : undefined,
      });
    } catch {
      // skip malformed lines
    }
  }

  return messages;
}
