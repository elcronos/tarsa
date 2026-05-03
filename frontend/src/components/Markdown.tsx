import type { ReactNode } from "react";

/**
 * Minimal markdown renderer — no external dependencies.
 * Handles: ## headings, **bold**, `inline code`, ```code blocks```, - bullet lists, [text](url).
 */

// ── Token types ───────────────────────────────────────────────────────────────

type Token =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "bullet"; text: string }
  | { type: "code_block"; lang: string; text: string }
  | { type: "paragraph"; text: string };

// ── Block tokenizer ───────────────────────────────────────────────────────────

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const lines = src.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Code block fence
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        bodyLines.push(lines[i]!);
        i++;
      }
      i++; // consume closing ```
      tokens.push({ type: "code_block", lang, text: bodyLines.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1]!.length, 3) as 1 | 2 | 3;
      tokens.push({ type: "heading", level, text: headingMatch[2]! });
      i++;
      continue;
    }

    // Bullet list item
    if (/^[-*]\s+/.test(line)) {
      tokens.push({ type: "bullet", text: line.replace(/^[-*]\s+/, "") });
      i++;
      continue;
    }

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — accumulate consecutive non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("```") &&
      !/^#{1,3}\s/.test(lines[i]!) &&
      !/^[-*]\s/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      tokens.push({ type: "paragraph", text: paraLines.join(" ") });
    }
  }

  return tokens;
}

// ── Inline renderer ───────────────────────────────────────────────────────────

function renderInline(text: string): ReactNode[] {
  // Split on **bold**, `code`, and [text](url) patterns
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }

    const raw = match[0]!;

    if (raw.startsWith("**")) {
      parts.push(
        <strong key={match.index} className="font-semibold text-white">
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith("`")) {
      parts.push(
        <code
          key={match.index}
          className="px-1 rounded bg-zinc-900 text-zinc-300 font-mono text-[0.9em]"
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else {
      // Link: [text](url)
      const linkMatch = raw.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        parts.push(
          <a
            key={match.index}
            href={linkMatch[2]!}
            className="text-blue-400 underline hover:text-blue-300"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkMatch[1]!}
          </a>
        );
      } else {
        parts.push(raw);
      }
    }

    last = match.index + raw.length;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return parts;
}

// ── Main Markdown component ───────────────────────────────────────────────────

interface MarkdownProps {
  content: string;
  className?: string;
}

export default function Markdown({ content, className = "" }: MarkdownProps) {
  const tokens = tokenize(content);

  const elements = tokens.map((token, idx) => {
    switch (token.type) {
      case "heading": {
        const base = "font-semibold text-white leading-snug";
        if (token.level === 1)
          return (
            <h1 key={idx} className={`text-base ${base} mt-3 mb-1`}>
              {renderInline(token.text)}
            </h1>
          );
        if (token.level === 2)
          return (
            <h2 key={idx} className={`text-sm ${base} mt-2 mb-1`}>
              {renderInline(token.text)}
            </h2>
          );
        return (
          <h3 key={idx} className={`text-xs ${base} mt-2 mb-0.5`}>
            {renderInline(token.text)}
          </h3>
        );
      }
      case "code_block":
        return (
          <pre
            key={idx}
            className="rounded bg-zinc-900 p-2 text-[10px] font-mono text-zinc-300 overflow-x-auto my-1"
          >
            <code>{token.text}</code>
          </pre>
        );
      case "bullet":
        return (
          <li key={idx} className="ml-3 text-[11px] text-zinc-300 leading-relaxed list-disc">
            {renderInline(token.text)}
          </li>
        );
      case "paragraph":
        return (
          <p key={idx} className="text-[11px] text-zinc-300 leading-relaxed">
            {renderInline(token.text)}
          </p>
        );
    }
  });

  // Wrap consecutive bullet items in a <ul>
  const grouped: ReactNode[] = [];
  let bulletBuf: ReactNode[] = [];

  for (const el of elements) {
    if (el && (el as React.ReactElement).type === "li") {
      bulletBuf.push(el);
    } else {
      if (bulletBuf.length > 0) {
        grouped.push(
          <ul key={`ul-${grouped.length}`} className="my-1 space-y-0.5 pl-1">
            {bulletBuf}
          </ul>
        );
        bulletBuf = [];
      }
      grouped.push(el);
    }
  }
  if (bulletBuf.length > 0) {
    grouped.push(
      <ul key={`ul-${grouped.length}`} className="my-1 space-y-0.5 pl-1">
        {bulletBuf}
      </ul>
    );
  }

  return (
    <div className={`space-y-1 ${className}`}>
      {grouped}
    </div>
  );
}

// ── Detection helper ──────────────────────────────────────────────────────────

/**
 * Returns true if the string looks like markdown (has headings, bold, code fences, or bullet lists).
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,3}\s/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /```/.test(text) ||
    /^[-*]\s/m.test(text)
  );
}
