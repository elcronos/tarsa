/** Reusable amber "stuck" badge with pulsing animation */

interface StuckBadgeProps {
  reason: string;
  size?: "sm" | "md";
}

export default function StuckBadge({ reason, size = "sm" }: StuckBadgeProps) {
  const textSize = size === "md" ? "text-xs" : "text-[10px]";
  const px = size === "md" ? "px-2 py-1" : "px-1.5 py-0.5";

  return (
    <span
      className={`inline-flex items-center gap-1 ${px} rounded font-mono ${textSize} bg-amber-500/15 border border-amber-500/30 text-amber-400`}
      title={reason}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
      stuck
    </span>
  );
}
