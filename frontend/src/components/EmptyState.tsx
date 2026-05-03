interface EmptyStateProps {
  message: string;
}

export default function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-2">
        <span className="text-[var(--fg-subtle)] font-mono text-lg select-none">*</span>
        <span className="text-[var(--fg-subtle)] text-sm font-mono text-center max-w-xs">
          {message}
        </span>
      </div>
    </div>
  );
}
