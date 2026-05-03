import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AgentScope] ErrorBoundary caught:", error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center bg-[var(--bg)]">
          <div className="rounded border border-red-500/40 bg-red-500/10 p-6 max-w-md w-full mx-4 text-center space-y-3">
            <div className="text-xs font-mono text-red-400 font-semibold uppercase tracking-wider">
              Render Error
            </div>
            <div className="text-sm font-mono text-red-300 break-words">
              {this.state.error?.message ?? "Unknown error"}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 px-4 py-1.5 rounded border border-red-500/40 text-xs font-mono text-red-400 hover:bg-red-500/20 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
