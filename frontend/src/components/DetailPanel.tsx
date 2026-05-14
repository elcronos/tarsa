import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import type { Agent, Event, Session, ToolCall, CostSource } from "../types";
import { formatDuration, formatCost, formatTime } from "../utils/format";
import { extractFilesTouched } from "../utils/files";
import SessionCostCard from "./SessionCostCard";
import CommitCostCard from "./CommitCostCard";
import IOPair from "./IOPair";
import JsonView, { tryParseJson } from "./JsonView";
import Markdown, { looksLikeMarkdown } from "./Markdown";
import { summarizeTool } from "../utils/toolSummary";
import { extractBrief } from "../utils/promptBrief";
import { parseSlashCommand } from "../utils/slashCommand";
import { isTeamWorker } from "../utils/team";
import { relativeTime } from "../utils/relativeTime";
import LoadingDots from "./LoadingDots";

function costSourceLabel(source: CostSource): string {
  if (source === "measured") return "Measured";
  if (source === "estimated_chars") return "Estimated (chars)";
  return "Estimated (tool count)";
}

function CostProvenanceBadge({ source }: { source: CostSource }) {
  const styles: Record<CostSource, string> = {
    measured: "bg-green-500/15 text-green-400",
    estimated_chars: "bg-amber-500/15 text-amber-400",
    tool_count_fallback: "bg-[var(--surface-raised)] text-[var(--fg-subtle)]",
  };
  return (
    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${styles[source]}`}>
      {costSourceLabel(source)}
    </span>
  );
}

interface DetailPanelProps {
  agent: Agent;
  session?: Session;
  events: Event[];
  toolCalls: ToolCall[];
  onClose: () => void;
  /** When true, hide the agent-scoped Terminal tab. Used so the user
   *  doesn't see two terminals when a project terminal is already docked. */
  hideTerminalTab?: boolean;
}

// ── Tab definitions ──────────────────────────────────────────────────────────

type TabId = "trace" | "thread" | "files" | "prompt" | "result" | "terminal";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "trace", label: "Trace" },
  { id: "thread", label: "Thread" },
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
  { id: "prompt", label: "Prompt" },
  { id: "result", label: "Result" },
];

// ── Sub-components ───────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-3 space-y-1.5">
      <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] font-mono text-[var(--fg-subtle)]">{label}</span>
      <span className="text-[10px] font-mono text-[var(--fg-muted)]">{value}</span>
    </div>
  );
}

function ExpandableBlock({
  content,
  collapseThreshold = 500,
  defaultExpanded = false,
}: {
  content: string;
  collapseThreshold?: number;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(
    defaultExpanded || content.length <= collapseThreshold
  );
  const shouldCollapse = content.length > collapseThreshold;
  const parsed = tryParseJson(content);

  if (parsed !== null && typeof parsed === "object") {
    return (
      <div className="rounded bg-[var(--bg)] p-2 max-h-[600px] overflow-auto">
        <JsonView value={parsed} />
      </div>
    );
  }

  const isMarkdown = looksLikeMarkdown(content);

  return (
    <div>
      <div
        className={`leading-relaxed break-words ${
          expanded ? "" : "max-h-20 overflow-hidden"
        }`}
      >
        {isMarkdown ? (
          <Markdown content={content} />
        ) : (
          <span className="text-[10px] font-mono text-[var(--fg-muted)] whitespace-pre-wrap">
            {content}
          </span>
        )}
      </div>
      {shouldCollapse && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg)] underline"
        >
          {expanded ? "collapse" : `show all (${content.length} chars)`}
        </button>
      )}
    </div>
  );
}

function TraceRow({ tc }: { tc: ToolCall; maxDuration: number }) {
  const [expanded, setExpanded] = useState(false);

  const dotColor =
    tc.status === "error"
      ? "bg-red-500"
      : tc.status === "running"
        ? "bg-blue-500"
        : "bg-emerald-500";

  const isRetry = tc.retry_of != null;
  const summary = summarizeTool(tc.tool_name, tc.input);

  return (
    <div>
      <div
        className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-[var(--surface-raised)] rounded px-1"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Status dot */}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        {/* Tool name */}
        <span className="text-[10px] font-mono text-[var(--fg-muted)] w-24 shrink-0 truncate">
          {tc.tool_name}
        </span>
        {/* Retry badge */}
        {isRetry && (
          <span className="text-[9px] font-mono text-amber-400 bg-amber-400/10 px-1 rounded shrink-0">
            ↻ retry
          </span>
        )}
        {/* Description summary (replaces bar) */}
        <span
          className="flex-1 text-[10px] font-mono text-[var(--fg-subtle)] truncate"
          title={summary}
        >
          {summary}
        </span>
        {/* Duration */}
        <span className="text-[10px] font-mono text-[var(--fg-subtle)] w-14 text-right shrink-0">
          {tc.duration_ms != null ? formatDuration(tc.duration_ms) : "…"}
        </span>
        {/* Time */}
        <span className="text-[10px] font-mono text-[var(--fg-subtle)] w-16 shrink-0">
          {formatTime(tc.started_ms)}
        </span>
      </div>
      {expanded && (
        <div className="ml-2 mt-1 mb-1">
          <IOPair
            input={tc.input && Object.keys(tc.input).length > 0 ? tc.input : undefined}
            output={tc.response ?? null}
            truncateAt={5000}
            toolName={tc.tool_name}
          />
        </div>
      )}
    </div>
  );
}

// ── Tab content components ────────────────────────────────────────────────────

function TraceTab({
  agent,
  events,
  toolCalls,
}: {
  agent: Agent;
  events: Event[];
  toolCalls: ToolCall[];
}) {
  const [costSource, setCostSource] = useState<CostSource | null>(null);

  useEffect(() => {
    if (!agent.session_id) return;
    let cancelled = false;
    fetch(`/api/insights?session=${encodeURIComponent(agent.session_id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { costEstimate?: { source?: CostSource } } | null) => {
        if (!cancelled && data?.costEstimate?.source) {
          setCostSource(data.costEstimate.source);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agent.session_id]);

  const { totalUsd, tokenShare } = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const e of events) {
      if (e.agent_id !== agent.id) continue;
      if (typeof e["input_tokens"] === "number") inputTokens += e["input_tokens"] as number;
      if (typeof e["output_tokens"] === "number") outputTokens += e["output_tokens"] as number;
    }
    const usd = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
    let totalInput = 0;
    let totalOutput = 0;
    for (const e of events) {
      if (typeof e["input_tokens"] === "number") totalInput += e["input_tokens"] as number;
      if (typeof e["output_tokens"] === "number") totalOutput += e["output_tokens"] as number;
    }
    const totalTokens = totalInput + totalOutput;
    const agentTokens = inputTokens + outputTokens;
    const share = totalTokens > 0 ? Math.round((agentTokens / totalTokens) * 100) : 0;
    return { totalUsd: usd, tokenShare: share };
  }, [events, agent.id]);

  const maxDuration = useMemo(
    () => Math.max(1, ...toolCalls.map((tc) => tc.duration_ms ?? 0)),
    [toolCalls]
  );

  const annotatedCalls = useMemo(() => {
    const seenToolUseIds = new Map<string, number>();
    const retryIds = new Set<string>();
    for (const tc of toolCalls) {
      if (tc.retry_of) {
        retryIds.add(tc.id);
        continue;
      }
      if (seenToolUseIds.has(tc.id)) {
        retryIds.add(tc.id);
      } else {
        seenToolUseIds.set(tc.id, tc.started_ms);
      }
    }
    return toolCalls.map((tc) => ({
      ...tc,
      retry_of: tc.retry_of ?? (retryIds.has(tc.id) ? "prev" : null),
    }));
  }, [toolCalls]);

  const durationMs =
    agent.status === "active"
      ? Date.now() - agent.first_seen_ms
      : agent.last_seen_ms - agent.first_seen_ms;

  return (
    <div className="space-y-3">
      <Card title="Performance">
        <StatRow label="status" value={agent.status} />
        <StatRow label="duration" value={formatDuration(durationMs)} />
        <StatRow label="tool calls" value={String(agent.tool_count)} />
        <StatRow label="errors" value={String(agent.error_count)} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-mono text-[var(--fg-subtle)]">est. cost</span>
          <div className="flex items-center gap-1.5">
            {costSource && <CostProvenanceBadge source={costSource} />}
            <span className="text-[10px] font-mono text-[var(--fg-muted)]">
              {totalUsd > 0 ? formatCost(totalUsd) : "–"}
            </span>
          </div>
        </div>
        <StatRow label="token share" value={tokenShare > 0 ? `${tokenShare}%` : "–"} />
        {agent.anomaly_score !== undefined && (
          <StatRow label="anomaly score" value={String(agent.anomaly_score)} />
        )}
        {agent.prompt_hash !== undefined && (
          <StatRow label="prompt hash" value={agent.prompt_hash} />
        )}
      </Card>

      {toolCalls.length > 0 && (
        <Card title="Execution trace">
          <div className="space-y-0.5 max-h-64 overflow-y-auto">
            {annotatedCalls.map((tc) => (
              <TraceRow key={tc.id} tc={tc} maxDuration={maxDuration} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

interface TranscriptMsg {
  type: string;
  content: string;
  ts: number;
  role?: string;
}

function SystemMessageCard({ msg }: { msg: TranscriptMsg }) {
  const [expanded, setExpanded] = useState(false);
  const preview = msg.content.slice(0, 80) + (msg.content.length > 80 ? "…" : "");
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
      <button
        className="w-full text-left text-[10px] font-mono text-[var(--fg-subtle)] flex items-center gap-1"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-[9px] font-mono px-1 rounded bg-zinc-700 text-zinc-400 shrink-0">system</span>
        <span className="truncate flex-1">{expanded ? "" : preview}</span>
        <span className="shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <pre className="mt-1 text-[10px] font-mono text-[var(--fg-muted)] whitespace-pre-wrap break-words leading-relaxed">
          {msg.content}
        </pre>
      )}
    </div>
  );
}

function UserMessageCard({ msg }: { msg: TranscriptMsg }) {
  return (
    <div className="rounded border border-blue-500/30 bg-blue-500/5 px-3 py-2">
      <div className="text-[9px] font-mono text-blue-400 mb-1">user</div>
      <pre className="text-[10px] font-mono text-[var(--fg-muted)] whitespace-pre-wrap break-words leading-relaxed">
        {msg.content}
      </pre>
    </div>
  );
}

function AssistantMessageCard({ msg }: { msg: TranscriptMsg }) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="text-[9px] font-mono text-[var(--fg-subtle)] mb-1">assistant</div>
      <Markdown content={msg.content} />
    </div>
  );
}

function ToolCallCard({ msg }: { msg: TranscriptMsg }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
      <button
        className="w-full text-left text-[10px] font-mono text-[var(--fg-subtle)] flex items-center gap-1"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-[9px] font-mono px-1 rounded bg-amber-500/20 text-amber-400 shrink-0">
          {msg.type}
        </span>
        <span className="shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <pre className="mt-1 text-[10px] font-mono text-[var(--fg-muted)] whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-auto">
          {msg.content}
        </pre>
      )}
    </div>
  );
}

// ── Thread-specific helpers ───────────────────────────────────────────────────

type MessageRole = "system" | "user" | "assistant" | "tool_use" | "tool_result";

function getRole(msg: TranscriptMsg): MessageRole {
  const r = msg.role ?? msg.type;
  if (r === "system") return "system";
  if (r === "user") return "user";
  if (r === "assistant") return "assistant";
  if (r === "tool_use") return "tool_use";
  return "tool_result";
}

/** Returns a 1-line input summary for tool_use messages */
function toolInputSummary(content: string): string {
  const parsed = tryParseJson(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const vals = Object.values(parsed as Record<string, unknown>);
    for (const v of vals) {
      if (typeof v === "string" && v.length > 0) {
        return v.length > 80 ? v.slice(0, 80) + "…" : v;
      }
    }
  }
  return content.length > 80 ? content.slice(0, 80) + "…" : content;
}

/** Extract tool name from tool_use content (JSON with "name" or raw) */
function toolName(msg: TranscriptMsg): string {
  const parsed = tryParseJson(msg.content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const p = parsed as Record<string, unknown>;
    if (typeof p["name"] === "string") return p["name"];
    if (typeof p["tool_name"] === "string") return p["tool_name"];
  }
  return msg.type === "tool_use" ? "tool_use" : msg.type;
}

// ── Turn grouping ─────────────────────────────────────────────────────────────

type TurnKind = "system-group" | "user-turn" | "assistant-turn";

interface SystemGroupTurn {
  kind: "system-group";
  messages: TranscriptMsg[];
}

interface UserTurn {
  kind: "user-turn";
  index: number;
  msg: TranscriptMsg;
}

interface AssistantTurn {
  kind: "assistant-turn";
  index: number;
  assistant: TranscriptMsg | null;
  tools: TranscriptMsg[];
}

type Turn = SystemGroupTurn | UserTurn | AssistantTurn;

function groupIntoTurns(messages: TranscriptMsg[]): Turn[] {
  const turns: Turn[] = [];
  let userCount = 0;
  let assistantCount = 0;

  const systemMsgs: TranscriptMsg[] = [];
  let i = 0;

  // Collect leading system messages
  while (i < messages.length && getRole(messages[i]!) === "system") {
    systemMsgs.push(messages[i]!);
    i++;
  }
  if (systemMsgs.length > 0) {
    turns.push({ kind: "system-group", messages: systemMsgs });
  }

  while (i < messages.length) {
    const msg = messages[i]!;
    const role = getRole(msg);

    if (role === "system") {
      // Stray system message — attach to previous system group or create new
      const last = turns[turns.length - 1];
      if (last && last.kind === "system-group") {
        last.messages.push(msg);
      } else {
        turns.push({ kind: "system-group", messages: [msg] });
      }
      i++;
      continue;
    }

    if (role === "user") {
      userCount++;
      turns.push({ kind: "user-turn", index: userCount, msg });
      i++;
      continue;
    }

    if (role === "assistant") {
      assistantCount++;
      const toolMsgs: TranscriptMsg[] = [];
      i++;
      // Consume following tool_use and tool_result blocks
      while (
        i < messages.length &&
        (getRole(messages[i]!) === "tool_use" || getRole(messages[i]!) === "tool_result")
      ) {
        toolMsgs.push(messages[i]!);
        i++;
      }
      turns.push({ kind: "assistant-turn", index: assistantCount, assistant: msg, tools: toolMsgs });
      continue;
    }

    // Orphaned tool_use / tool_result — attach to last assistant turn or create one
    const last = turns[turns.length - 1];
    if (last && last.kind === "assistant-turn") {
      last.tools.push(msg);
    } else {
      assistantCount++;
      turns.push({ kind: "assistant-turn", index: assistantCount, assistant: null, tools: [msg] });
    }
    i++;
  }

  return turns;
}

// ── Fuzzy match ───────────────────────────────────────────────────────────────

function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let ci = 0; ci < lower.length && qi < q.length; ci++) {
    if (lower[ci] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ── Per-role colors ───────────────────────────────────────────────────────────

const ROLE_CHIP_STYLE: Record<MessageRole, string> = {
  system: "text-zinc-400 bg-zinc-700/40 border-zinc-600/40",
  user: "text-blue-400 bg-blue-500/10 border-blue-500/30",
  assistant: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
  tool_use: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  tool_result: "text-orange-400 bg-orange-500/10 border-orange-500/30",
};

// ── Timestamp badge ───────────────────────────────────────────────────────────

function TsBadge({ ts }: { ts: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!ts) return null;
  return (
    <span className="text-[9px] font-mono text-[var(--fg-subtle)] opacity-0 group-hover:opacity-100 transition-opacity ml-auto shrink-0">
      {relativeTime(ts, now)}
    </span>
  );
}

// ── Collapsible message content ───────────────────────────────────────────────

function MsgContent({ content, defaultCollapsed = false }: { content: string; defaultCollapsed?: boolean }) {
  const THRESHOLD = 500;
  const [expanded, setExpanded] = useState(!defaultCollapsed && content.length <= THRESHOLD);

  const parsed = tryParseJson(content);
  if (parsed !== null && typeof parsed === "object") {
    return (
      <div>
        <div className={expanded ? "" : "max-h-20 overflow-hidden relative"}>
          <div className="rounded bg-[var(--bg)] p-2 max-h-[400px] overflow-auto">
            <JsonView value={parsed} />
          </div>
          {!expanded && (
            <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[var(--surface)] to-transparent" />
          )}
        </div>
        {content.length > THRESHOLD && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg)] underline"
          >
            {expanded ? "collapse" : `show all (${content.length} chars)`}
          </button>
        )}
      </div>
    );
  }

  const isMarkdown = looksLikeMarkdown(content);

  return (
    <div>
      <div className={`leading-relaxed break-words ${expanded ? "" : "max-h-20 overflow-hidden relative"}`}>
        {isMarkdown ? (
          <Markdown content={content} />
        ) : (
          <span className="text-[10px] font-mono text-[var(--fg-muted)] whitespace-pre-wrap">
            {content}
          </span>
        )}
        {!expanded && content.length > THRESHOLD && (
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[var(--surface)] to-transparent" />
        )}
      </div>
      {content.length > THRESHOLD && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg)] underline"
        >
          {expanded ? "collapse" : `show all (${content.length} chars)`}
        </button>
      )}
    </div>
  );
}

// ── SystemGroupCard ───────────────────────────────────────────────────────────

function SystemGroupCard({ turn }: { turn: SystemGroupTurn }) {
  const [expanded, setExpanded] = useState(false);
  const count = turn.messages.length;
  return (
    <div className="rounded border border-zinc-700/50 bg-[var(--bg)] px-3 py-2 space-y-2">
      <button
        className="w-full text-left text-[10px] font-mono text-[var(--fg-subtle)] flex items-center gap-2"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-zinc-700/40 text-zinc-400 border-zinc-600/40 shrink-0">
          system
        </span>
        <span className="flex-1 text-zinc-500">
          {expanded ? `${count} system message${count !== 1 ? "s" : ""}` : `+ ${count} system message${count !== 1 ? "s" : ""} (click to show)`}
        </span>
        <span className="shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && turn.messages.map((msg, i) => (
        <div key={i} className="border-t border-zinc-700/30 pt-2">
          <pre className="text-[10px] font-mono text-[var(--fg-muted)] whitespace-pre-wrap break-words leading-relaxed">
            {msg.content}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ── UserTurnCard ──────────────────────────────────────────────────────────────

function UserTurnCard({ turn, dim }: { turn: UserTurn; dim: boolean }) {
  return (
    <div className={`rounded border border-blue-500/30 bg-blue-500/5 px-3 py-2 group transition-opacity ${dim ? "opacity-30" : ""}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border text-blue-400 bg-blue-500/10 border-blue-500/30 shrink-0">
          user {turn.index}
        </span>
        <TsBadge ts={turn.msg.ts} />
      </div>
      <MsgContent content={turn.msg.content} />
    </div>
  );
}

// ── ToolMsgRow ────────────────────────────────────────────────────────────────

function ToolMsgRow({ msg }: { msg: TranscriptMsg }) {
  const [expanded, setExpanded] = useState(false);
  const role = getRole(msg);
  const chipStyle = ROLE_CHIP_STYLE[role];

  const label = role === "tool_use" ? toolName(msg) : "tool_result";
  const summary = role === "tool_use" ? toolInputSummary(msg.content) : null;

  return (
    <div className="border border-[var(--border)] rounded bg-[var(--bg)] px-2 py-1.5 group">
      <button
        className="w-full text-left flex items-center gap-1.5"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${chipStyle}`}>
          {label}
        </span>
        {summary && !expanded && (
          <span className="text-[10px] font-mono text-[var(--fg-subtle)] truncate flex-1">{summary}</span>
        )}
        <TsBadge ts={msg.ts} />
        <span className="text-[9px] text-[var(--fg-subtle)] shrink-0 ml-auto">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="mt-1.5">
          <MsgContent content={msg.content} />
        </div>
      )}
    </div>
  );
}

// ── AssistantTurnCard ─────────────────────────────────────────────────────────

function AssistantTurnCard({ turn, dim }: { turn: AssistantTurn; dim: boolean }) {
  return (
    <div
      id={`turn-a-${turn.index}`}
      className={`rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 space-y-2 group transition-opacity ${dim ? "opacity-30" : ""}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border text-emerald-400 bg-emerald-500/10 border-emerald-500/30 shrink-0">
          turn {turn.index}
        </span>
        {turn.assistant && <TsBadge ts={turn.assistant.ts} />}
      </div>
      {turn.assistant && (
        <MsgContent content={turn.assistant.content} />
      )}
      {turn.tools.length > 0 && (
        <div className="space-y-1 border-t border-[var(--border)] pt-2 mt-1">
          {turn.tools.map((t, i) => (
            <ToolMsgRow key={i} msg={t} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── MiniMap ───────────────────────────────────────────────────────────────────

function MiniMap({ turns, scrollContainerRef }: { turns: Turn[]; scrollContainerRef: React.RefObject<HTMLDivElement | null> }) {
  const dots: { color: string; role: string; index: number }[] = [];
  for (const t of turns) {
    if (t.kind === "system-group") {
      dots.push({ color: "bg-zinc-600", role: "system", index: dots.length });
    } else if (t.kind === "user-turn") {
      dots.push({ color: "bg-blue-500", role: "user", index: dots.length });
    } else {
      dots.push({ color: "bg-emerald-500", role: "assistant", index: dots.length });
      for (const tool of t.tools) {
        const r = getRole(tool);
        dots.push({
          color: r === "tool_use" ? "bg-amber-500" : "bg-orange-500",
          role: r,
          index: dots.length,
        });
      }
    }
  }

  const scrollTo = useCallback((dotIndex: number) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const items = container.querySelectorAll("[data-msg-index]");
    const el = items[dotIndex] as HTMLElement | undefined;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [scrollContainerRef]);

  return (
    <div className="flex flex-col gap-0.5 py-1 w-3 shrink-0 items-center">
      {dots.map((d, i) => (
        <button
          key={i}
          title={d.role}
          onClick={() => scrollTo(d.index)}
          className={`w-1.5 h-1.5 rounded-full ${d.color} opacity-60 hover:opacity-100 transition-opacity shrink-0`}
        />
      ))}
    </div>
  );
}

// ── ThreadTab ─────────────────────────────────────────────────────────────────

function ThreadTab({ agent }: { agent: Agent }) {
  const [messages, setMessages] = useState<TranscriptMsg[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolled = useRef(false);
  const userScrolled = useRef(false);

  // Filter state
  const [visibleRoles, setVisibleRoles] = useState<Set<MessageRole>>(
    new Set(["system", "user", "assistant", "tool_use", "tool_result"])
  );
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agent/${encodeURIComponent(agent.id)}/transcript`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setMessages((data as { messages: TranscriptMsg[] }).messages);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agent.id]);

  // Auto-scroll only on initial load
  useEffect(() => {
    if (messages && !hasAutoScrolled.current && bottomRef.current) {
      hasAutoScrolled.current = true;
      if (!userScrolled.current) {
        bottomRef.current.scrollIntoView({ behavior: "instant" });
      }
    }
  }, [messages]);

  // Track user scroll to disable auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { userScrolled.current = true; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const toggleRole = (role: MessageRole) => {
    setVisibleRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) {
        if (next.size === 1) return prev; // keep at least one
        next.delete(role);
      } else {
        next.add(role);
      }
      return next;
    });
  };

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };
  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  if (messages === null) {
    return <LoadingDots label="transcript" />;
  }

  if (messages.length === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)] py-4 text-center px-4">
        No transcript available for this agent — typically only Claude Code subagents (spawned via the Agent tool) have transcripts.
      </div>
    );
  }

  // Counts
  const counts: Record<MessageRole, number> = {
    system: 0, user: 0, assistant: 0, tool_use: 0, tool_result: 0,
  };
  for (const m of messages) counts[getRole(m)]++;
  const totalTurns = counts.user + counts.assistant;

  const turns = groupIntoTurns(messages);

  // Chip definitions
  const CHIPS: Array<{ role: MessageRole; label: string; style: string }> = [
    { role: "system", label: `sys ${counts.system}`, style: ROLE_CHIP_STYLE.system },
    { role: "user", label: `user ${counts.user}`, style: ROLE_CHIP_STYLE.user },
    { role: "assistant", label: `asst ${counts.assistant}`, style: ROLE_CHIP_STYLE.assistant },
    { role: "tool_use", label: `tool ${counts.tool_use + counts.tool_result}`, style: ROLE_CHIP_STYLE.tool_use },
  ];

  // For "tool" chip we toggle both tool_use and tool_result together
  const toggleTool = () => {
    setVisibleRoles((prev) => {
      const next = new Set(prev);
      const bothOn = next.has("tool_use") && next.has("tool_result");
      if (bothOn) {
        if (next.size <= 2) return prev;
        next.delete("tool_use");
        next.delete("tool_result");
      } else {
        next.add("tool_use");
        next.add("tool_result");
      }
      return next;
    });
  };

  const toolVisible = visibleRoles.has("tool_use") || visibleRoles.has("tool_result");

  return (
    <div className="flex flex-col h-full -m-3">
      {/* Sticky header bar */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 space-y-2">
        {/* Summary line + jump buttons */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-mono text-[var(--fg-subtle)] shrink-0">
            {totalTurns} turns · {counts.system} sys · {counts.user} user · {counts.assistant} asst · {counts.tool_use + counts.tool_result} tool
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={scrollToTop}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:bg-[var(--surface-raised)] transition-colors"
              title="Jump to top"
            >
              ↑ Top
            </button>
            <button
              onClick={scrollToBottom}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:bg-[var(--surface-raised)] transition-colors"
              title="Jump to bottom"
            >
              ↓ Bottom
            </button>
          </div>
        </div>
        {/* Filter chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {CHIPS.map((chip) => {
            const on = chip.role === "tool_use" ? toolVisible : visibleRoles.has(chip.role);
            const handleClick = chip.role === "tool_use" ? toggleTool : () => toggleRole(chip.role);
            return (
              <button
                key={chip.role}
                onClick={handleClick}
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-opacity ${
                  on ? chip.style : "text-[var(--fg-subtle)] border-[var(--border)] opacity-40"
                }`}
              >
                {chip.label}
              </button>
            );
          })}
          {/* Search input */}
          <input
            type="text"
            placeholder="search…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] placeholder-[var(--fg-subtle)] focus:outline-none focus:border-[var(--accent)] w-28"
          />
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex flex-1 overflow-hidden">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
          {turns.map((turn, ti) => {
            if (turn.kind === "system-group") {
              if (!visibleRoles.has("system")) return null;
              const matchesSearch = !searchQuery || turn.messages.some((m) =>
                fuzzyMatch(m.content, searchQuery)
              );
              return (
                <div key={ti} data-msg-index={ti}>
                  <SystemGroupCard turn={turn} />
                </div>
              );
            }

            if (turn.kind === "user-turn") {
              if (!visibleRoles.has("user")) return null;
              const matchesSearch = !searchQuery || fuzzyMatch(turn.msg.content, searchQuery);
              return (
                <div key={ti} data-msg-index={ti}>
                  <UserTurnCard turn={turn} dim={!!searchQuery && !matchesSearch} />
                </div>
              );
            }

            // assistant-turn
            const assistantVisible = visibleRoles.has("assistant");
            const toolsVisible = toolVisible;

            // Check if this whole turn matches search
            const assistantMatch = !searchQuery || (turn.assistant ? fuzzyMatch(turn.assistant.content, searchQuery) : false);
            const toolsMatch = !searchQuery || turn.tools.some((t) => fuzzyMatch(t.content, searchQuery));
            const turnMatchesSearch = assistantMatch || toolsMatch;
            const dim = !!searchQuery && !turnMatchesSearch;

            if (!assistantVisible && !toolsVisible) return null;

            // If only some parts are visible, still show the turn card but filter tools
            const filteredTurn: AssistantTurn = {
              ...turn,
              assistant: assistantVisible ? turn.assistant : null,
              tools: toolsVisible ? turn.tools : [],
            };
            if (filteredTurn.assistant === null && filteredTurn.tools.length === 0) return null;

            return (
              <div key={ti} data-msg-index={ti}>
                <AssistantTurnCard turn={filteredTurn} dim={dim} />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Mini-map sidebar */}
        {turns.length > 5 && (
          <div className="shrink-0 border-l border-[var(--border)] bg-[var(--bg)] overflow-y-auto px-0.5">
            <MiniMap turns={turns} scrollContainerRef={scrollRef} />
          </div>
        )}
      </div>
    </div>
  );
}

function FilesTab({ toolCalls }: { toolCalls: ToolCall[] }) {
  const { reads, writes, edits } = useMemo(
    () => extractFilesTouched(toolCalls),
    [toolCalls]
  );

  const totalFiles = reads.length + writes.length + edits.length;

  if (totalFiles === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)] py-4 text-center">
        No files touched
      </div>
    );
  }

  return (
    <div className="space-y-0.5 max-h-80 overflow-y-auto">
      {reads.map((fp) => (
        <div key={`r:${fp}`} className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono px-1 rounded bg-blue-500/15 text-blue-400 shrink-0">read</span>
          <span className="text-[10px] font-mono text-[var(--fg-muted)] truncate" title={fp}>
            {fp.split("/").slice(-2).join("/")}
          </span>
        </div>
      ))}
      {writes.map((fp) => (
        <div key={`w:${fp}`} className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono px-1 rounded bg-green-500/15 text-green-400 shrink-0">wrote</span>
          <span className="text-[10px] font-mono text-[var(--fg-muted)] truncate" title={fp}>
            {fp.split("/").slice(-2).join("/")}
          </span>
        </div>
      ))}
      {edits.map((fp) => (
        <div key={`e:${fp}`} className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono px-1 rounded bg-amber-500/15 text-amber-400 shrink-0">edited</span>
          <span className="text-[10px] font-mono text-[var(--fg-muted)] truncate" title={fp}>
            {fp.split("/").slice(-2).join("/")}
          </span>
        </div>
      ))}
    </div>
  );
}

function PromptTab({ agent }: { agent: Agent }) {
  const [fetched, setFetched] = useState<{ prompt: string | null; source: string } | null>(
    null
  );
  const isTeam = isTeamWorker(agent);

  useEffect(() => {
    if (agent.prompt && agent.prompt.trim()) return;
    let cancelled = false;
    fetch(`/api/agent/${encodeURIComponent(agent.id)}/prompt`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setFetched(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.prompt]);

  const text = (agent.prompt && agent.prompt.trim()) ? agent.prompt : fetched?.prompt ?? null;
  const source = (agent.prompt && agent.prompt.trim()) ? "stored" : (fetched?.source ?? "none");

  if (!text) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)] py-4 text-center">
        No prompt available
      </div>
    );
  }

  const slash = parseSlashCommand(text);
  // Body shown below the slash-command card (if any). Falls back to full text.
  const bodyText = slash ? slash.rest : text;
  const regexBrief = bodyText ? extractBrief(bodyText) : "";

  // source labels — make clear what the user is looking at
  const sourceMeta: Record<string, { label: string; tone: string }> = {
    stored: { label: "captured at spawn", tone: "text-emerald-400" },
    spawn_tool: { label: "per-worker assignment · from parent Agent call", tone: "text-blue-400" },
    send_messages: { label: "per-worker SendMessage history · from parent", tone: "text-blue-400" },
    transcript: { label: "first user message from transcript (may be shared)", tone: "text-amber-400" },
  };
  const meta = sourceMeta[source];

  const transcriptFallbackOnTeam = isTeam && source === "transcript";

  return (
    <div className="space-y-2">
      {slash && <SlashCommandCard name={slash.name} args={slash.args} />}
      {regexBrief && <BriefCard agentId={agent.id} fallback={regexBrief} />}
      {meta && (
        <div className={`text-[10px] font-mono ${meta.tone}`}>{meta.label}</div>
      )}
      {transcriptFallbackOnTeam && (
        <div className="text-[10px] font-mono text-amber-400/80 bg-amber-500/5 border border-amber-500/20 rounded px-2 py-1">
          Per-worker assignment not captured. Showing transcript first user message —
          this is usually the parent's slash command and identical across workers.
        </div>
      )}
      {bodyText && (
        <ExpandableBlock content={bodyText} collapseThreshold={500} defaultExpanded />
      )}
    </div>
  );
}

function SlashCommandCard({ name, args }: { name: string; args: string }) {
  return (
    <div className="rounded border border-violet-500/30 px-3 py-2 bg-violet-500/5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[9px] font-mono text-violet-400 uppercase tracking-wider">
          slash command
        </span>
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <code className="text-[13px] font-mono text-violet-200">/{name}</code>
        {args && (
          <code className="text-[11px] font-mono text-[var(--fg-muted)] bg-[var(--bg)] rounded px-1.5 py-0.5">
            {args}
          </code>
        )}
      </div>
    </div>
  );
}

function BriefCard({ agentId, fallback }: { agentId: string; fallback: string }) {
  const [llm, setLlm] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/agent/${encodeURIComponent(agentId)}/brief`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setLoading(false);
        if (data && typeof data.brief === "string" && data.brief.trim()) {
          setLlm(data.brief);
        } else if (data && data.source === "error") {
          setError(typeof data.error === "string" ? data.error : "LLM call failed");
        } else if (data && data.source === "no_prompt") {
          setError("No prompt text available");
        }
      })
      .catch((err) => {
        setLoading(false);
        setError(String(err));
      });
  };

  const text = llm ?? fallback;
  const label = llm ? "brief · llm" : "brief · regex";

  return (
    <div className="rounded border border-emerald-500/30 px-3 py-2 bg-emerald-500/5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] font-mono text-emerald-500 uppercase tracking-wider">{label}</span>
        {!llm && (
          <button
            onClick={generate}
            disabled={loading}
            className="text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
            title="Generate AI summary via local claude CLI (haiku)"
          >
            {loading ? "summarizing…" : "✨ summarize"}
          </button>
        )}
      </div>
      <p className="text-[12px] text-emerald-200 leading-snug">{text}</p>
      {error && (
        <p className="mt-1 text-[10px] font-mono text-red-400">{error}</p>
      )}
    </div>
  );
}

function ResultTab({ agent }: { agent: Agent }) {
  const [fetched, setFetched] = useState<{ result: string | null; source: string } | null>(null);

  useEffect(() => {
    if (agent.result && agent.result.trim()) return;
    let cancelled = false;
    fetch(`/api/agent/${encodeURIComponent(agent.id)}/result`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setFetched(data as { result: string | null; source: string });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.result]);

  const text = (agent.result && agent.result.trim()) ? agent.result : fetched?.result ?? null;
  const source = fetched?.source;
  const sourceLabel =
    source === "tool" ? " (from parent tool response)" :
    source === "transcript" ? " (from transcript)" : "";

  if (!text) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)] py-4 text-center">
        No result captured
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sourceLabel && (
        <div className="text-[10px] font-mono text-[var(--fg-subtle)]">{sourceLabel.trim()}</div>
      )}
      <ExpandableBlock content={text} collapseThreshold={500} />
    </div>
  );
}

// ── GitBadge ─────────────────────────────────────────────────────────────────

function GitBadge({ session }: { session: Session }) {
  const [copied, setCopied] = useState(false);
  const { git_commit, git_branch, git_dirty } = session;
  if (!git_commit) return null;

  const shortSha = git_commit.slice(0, 7);

  const copySha = () => {
    navigator.clipboard.writeText(git_commit).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    }).catch(() => {});
  };

  return (
    <div className="flex items-center gap-1.5 mt-0.5">
      {git_branch && (
        <span className="text-[9px] font-mono text-[var(--fg-subtle)]">{git_branch}</span>
      )}
      {git_branch && <span className="text-[9px] text-[var(--fg-subtle)] opacity-40">·</span>}
      <button
        onClick={copySha}
        title={copied ? "Copied!" : `Copy full SHA: ${git_commit}`}
        className="text-[9px] font-mono text-[var(--fg-subtle)] hover:text-[var(--accent)] transition-colors"
      >
        {copied ? "Copied!" : shortSha}
      </button>
      {git_dirty && (
        <>
          <span className="text-[9px] text-[var(--fg-subtle)] opacity-40">·</span>
          <span className="text-[9px] font-mono text-amber-400" title="Uncommitted changes">●</span>
        </>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function DetailPanel({
  agent,
  session,
  events,
  toolCalls,
  onClose,
  hideTerminalTab = false,
}: DetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("prompt");
  // When the project terminal is already docked, drop the agent-scoped
  // Terminal tab so the user only sees one terminal at a time.
  const visibleTabs = hideTerminalTab ? TABS.filter((t) => t.id !== "terminal") : TABS;
  // Defensive: if the active tab was hidden out from under us, fall back.
  useEffect(() => {
    if (hideTerminalTab && activeTab === "terminal") setActiveTab("prompt");
  }, [hideTerminalTab, activeTab]);

  return (
    <div className="w-[720px] shrink-0 border-l border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
        <div className="min-w-0">
          <div className="text-xs font-mono font-medium text-[var(--fg)] truncate">
            {agent.description && agent.description !== agent.subagent_type
              ? agent.description
              : agent.name}
          </div>
          <div className="text-[10px] font-mono text-[var(--fg-subtle)]">
            {agent.subagent_type ?? "root agent"}
          </div>
          {session && <GitBadge session={session} />}
          <SessionCostCard sessionId={agent.session_id} />
          {session?.git_commit && <CommitCostCard sha={session.git_commit} />}
        </div>
        <button
          onClick={onClose}
          className="text-[var(--fg-subtle)] hover:text-[var(--fg)] text-sm ml-2 shrink-0"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Tab strip */}
      <div className="flex items-center border-b border-[var(--border)] shrink-0 px-1">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`
              px-2.5 py-1.5 text-[10px] font-mono transition-colors relative
              ${
                activeTab === tab.id
                  ? "text-[var(--fg)] border-b-2 border-[var(--accent)] -mb-px"
                  : "text-[var(--fg-muted)] hover:text-[var(--fg)]"
              }
            `}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scrollable tab content */}
      <div className="flex-1 overflow-y-auto p-3">
        {activeTab === "trace" && (
          <TraceTab agent={agent} events={events} toolCalls={toolCalls} />
        )}
        {activeTab === "thread" && (
          <ThreadTab agent={agent} />
        )}
        {activeTab === "files" && (
          <FilesTab toolCalls={toolCalls} />
        )}
        {activeTab === "prompt" && (
          <PromptTab agent={agent} />
        )}
        {activeTab === "result" && (
          <ResultTab agent={agent} />
        )}
        {activeTab === "terminal" && (
          <TerminalTab agent={agent} />
        )}
      </div>
    </div>
  );
}

function TerminalTab({ agent }: { agent: Agent }) {
  const [info, setInfo] = useState<{ enabled: boolean; port: number; token: string } | null>(
    null
  );
  const [sessionInfo, setSessionInfo] = useState<{ cwd: string | null; name: string | null; claudeSessionId: string | null } | null>(
    null
  );
  const [ensureStatus, setEnsureStatus] = useState<"idle" | "ensuring" | "ready" | "error">(
    "idle"
  );
  const [ccSessionId, setCcSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 1. Fetch cc-web port + token (one-shot, no agent dep).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/terminal/info")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Resolve this agent's session cwd so we can deeplink the terminal there.
  useEffect(() => {
    let cancelled = false;
    setSessionInfo(null);
    fetch(`/api/agent/${encodeURIComponent(agent.id)}/session`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (!cancelled) setSessionInfo({
          cwd: data.cwd ?? null,
          name: data.name ?? null,
          claudeSessionId: data.claudeSessionId ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setSessionInfo({ cwd: null, name: null, claudeSessionId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  // 3. Ask Tarsa to ensure cc-web has a session bound to that cwd. Once it
  //    exists, vultuk auto-attaches to the first tab on iframe load.
  useEffect(() => {
    if (!info?.enabled || !sessionInfo) return;
    if (!sessionInfo.cwd) {
      // No cwd known — fall back to letting vultuk show its folder picker.
      setEnsureStatus("ready");
      return;
    }
    let cancelled = false;
    setEnsureStatus("ensuring");
    setCcSessionId(null);
    fetch("/api/terminal/ensure-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: sessionInfo.cwd, name: sessionInfo.name ?? undefined }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.error ?? `HTTP ${r.status}`)))))
      .then((data: { sessionId?: string }) => {
        if (cancelled) return;
        if (data?.sessionId) setCcSessionId(data.sessionId);
        setEnsureStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setEnsureStatus("error");
        setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [info?.enabled, sessionInfo]);

  if (error) {
    return (
      <div className="text-[10px] font-mono text-red-400 py-4 text-center">
        Terminal unavailable: {error}
      </div>
    );
  }
  if (!info || !sessionInfo || ensureStatus === "ensuring" || ensureStatus === "idle") {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)] py-4 text-center">
        Loading terminal…
      </div>
    );
  }
  if (!info.enabled) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)] py-4 text-center">
        Embedded terminal disabled (TARSA_TERMINAL=0).
      </div>
    );
  }

  // ?single=1 tells the patched cc-web to hide its session tab bar so the
  // user can't spawn extra sessions from the agent-scoped right panel.
  const url = `http://localhost:${info.port}/?token=${encodeURIComponent(info.token)}&single=1${
    ccSessionId ? `&session=${encodeURIComponent(ccSessionId)}` : ""
  }${
    sessionInfo.claudeSessionId ? `&resume=${encodeURIComponent(sessionInfo.claudeSessionId)}` : ""
  }`;

  return (
    <div className="flex flex-col gap-1 h-full">
      <div className="flex items-center justify-between text-[9px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider">
        <span title={sessionInfo.cwd ?? ""}>
          terminal{sessionInfo.cwd ? ` · ${sessionInfo.cwd.split("/").slice(-2).join("/")}` : ""}
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--accent)] hover:underline normal-case tracking-normal"
        >
          open in new tab ↗
        </a>
      </div>
      <iframe
        title="Embedded terminal"
        src={url}
        // sandbox locks the iframe down. We allow only what the embedded
        // terminal genuinely needs:
        //   allow-scripts        — vultuk is a JS app
        //   allow-same-origin    — it makes same-origin XHR/WS to itself
        //   allow-forms          — auth form (kept even though we bypass)
        // Notably absent: allow-top-navigation (no escape from Tarsa frame),
        // allow-popups (no new windows), allow-modals (no native dialogs).
        sandbox="allow-scripts allow-same-origin allow-forms"
        // Clipboard is a Permissions-Policy feature, not a sandbox token —
        // it must go in `allow`, not `sandbox` (copy from terminal output).
        allow="clipboard-read; clipboard-write"
        // No-referrer in addition to the meta tag inside vultuk so initial
        // sub-resource fetches from CDNs never see the auth token.
        referrerPolicy="no-referrer"
        className="flex-1 w-full rounded border border-[var(--border)] bg-black"
        // xterm needs a real height to lay out its grid. The DetailPanel
        // tab body isn't full-height by default, so set an explicit min.
        style={{ minHeight: "70vh", height: "100%" }}
      />
    </div>
  );
}
