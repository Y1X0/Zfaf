import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';

/**
 * Error boundary around each section.
 *
 * A broken section must not take an invitation down. On the night of a wedding
 * a page that is missing one block is a nuisance; a blank page is not
 * recoverable — the link is already in hundreds of messages.
 *
 * Nothing is rendered in place of a failed section: an error message would be
 * worse for a guest than the section simply not being there.
 *
 * This class covers the client — hydration and interaction. It only covers the
 * *server* when the renderer places it inside a Suspense boundary, which
 * `renderSections` does for exactly that reason.
 */
interface Props {
  readonly sectionId: string;
  readonly variant: string;
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
}

export class SectionBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reported for the builder and error tracking; never surfaced to a guest.
    console.error(
      `[invitation-renderer] section "${this.props.sectionId}" (${this.props.variant}) failed to render`,
      { message: error.message, componentStack: info.componentStack },
    );
  }

  override render(): ReactElement | null {
    if (this.state.failed) return null;
    return <>{this.props.children}</>;
  }
}
