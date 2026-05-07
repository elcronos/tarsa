import { useEffect, useState } from "react";

interface LoadingDotsProps {
  label?: string;
}

const STYLE = `
@keyframes dag-pulse {
  0%, 100% { opacity: 0.2; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .dag-dot { animation: none !important; opacity: 0.6 !important; transform: none !important; }
}
`;

let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const el = document.createElement("style");
  el.textContent = STYLE;
  document.head.appendChild(el);
}

export default function LoadingDots({ label }: LoadingDotsProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    injectStyle();
    setMounted(true);
  }, []);

  const dotBase: React.CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: "50%",
    backgroundColor: "var(--accent, #2dd4bf)",
    display: "inline-block",
    animation: "dag-pulse 1.2s ease-in-out infinite",
    opacity: mounted ? undefined : 0.2,
  };

  return (
    <div
      className="flex items-center justify-center gap-2 py-6"
      role="status"
      aria-label={label ?? "Loading"}
    >
      {/* dot 1 → dot 2 → dot 3, arranged like a tiny DAG */}
      <span
        className="dag-dot"
        style={{ ...dotBase, animationDelay: "0ms" }}
      />
      {/* arrow connector */}
      <span
        className="text-[8px] font-mono select-none"
        style={{ color: "var(--fg-subtle, #52525b)", lineHeight: 1 }}
        aria-hidden="true"
      >
        →
      </span>
      <span
        className="dag-dot"
        style={{ ...dotBase, animationDelay: "200ms" }}
      />
      <span
        className="text-[8px] font-mono select-none"
        style={{ color: "var(--fg-subtle, #52525b)", lineHeight: 1 }}
        aria-hidden="true"
      >
        →
      </span>
      <span
        className="dag-dot"
        style={{ ...dotBase, animationDelay: "400ms" }}
      />
      {label && (
        <span className="ml-2 text-[10px] font-mono text-[var(--fg-subtle)]">
          {label}
        </span>
      )}
    </div>
  );
}
