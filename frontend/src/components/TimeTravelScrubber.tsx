import { formatTime } from "../utils/format";

interface TimeTravelScrubberProps {
  minTs: number;
  maxTs: number;
  scrubT: number | null;
  onChange: (t: number) => void;
  onClear: () => void;
}

export default function TimeTravelScrubber({
  minTs,
  maxTs,
  scrubT,
  onChange,
  onClear,
}: TimeTravelScrubberProps) {
  const range = Math.max(maxTs - minTs, 1);
  const value = scrubT !== null ? scrubT : maxTs;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(Number(e.target.value));
  };

  const scrubLabel: string = scrubT !== null
    ? (() => {
        const wallClock = new Date(scrubT).toLocaleTimeString();
        const pct = Math.round(((scrubT - minTs) / range) * 100);
        return `${wallClock} (${pct}% of session)`;
      })()
    : "live";

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-t border-[var(--border)] bg-[var(--surface)] shrink-0">
      <span className="text-[10px] font-mono text-[var(--fg-subtle)] shrink-0">
        {formatTime(minTs)}
      </span>

      <input
        type="range"
        min={minTs}
        max={maxTs}
        step={Math.max(1, Math.floor(range / 1000))}
        value={value}
        onChange={handleChange}
        className="flex-1 h-1 accent-[var(--accent)] cursor-pointer"
      />

      <span className="text-[10px] font-mono text-[var(--fg-subtle)] shrink-0">
        {formatTime(maxTs)}
      </span>

      <span className={`text-[10px] font-mono shrink-0 ${scrubT !== null ? "text-amber-400" : "text-[var(--fg-subtle)]"}`}>
        {scrubT !== null ? `⏮ ${scrubLabel}` : scrubLabel}
      </span>

      {scrubT !== null && (
        <button
          onClick={onClear}
          className="text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg)] px-1.5 py-0.5 rounded border border-[var(--border)] shrink-0"
        >
          live
        </button>
      )}
    </div>
  );
}
