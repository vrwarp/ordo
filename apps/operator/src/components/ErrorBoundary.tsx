import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '../services/log.ts';

/*
 * A render error kept to the part of the page it happened in (design/15 "Errors"): without a boundary React
 * unmounts the whole operator window on any render error, the navigation and the live controls with it. The
 * editor puts one around its canvas, its panels and its previews (an object no drawer expected must cost a
 * volunteer that pane, never the service), and the app one around each page.
 */

export type ErrorBoundaryProps = {
  /** What it guards, for the log line ('editor canvas'). */
  name: string;
  /** What shows instead of the children after an error: `retry` draws them again. */
  fallback: (retry: () => void) => ReactNode;
  /** A new value (the open slide, the draft after an undo, the page) draws the children again. */
  resetKey?: unknown;
  children?: ReactNode;
};

type State = { failed: boolean; key: unknown };

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { failed: false, key: undefined };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.key) ? null : { key: props.resetKey, failed: false };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const what = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const where = (info.componentStack ?? '').trim().split('\n')[0]?.trim() ?? '';
    log('error', `${this.props.name}: ${what}${where ? ` (${where})` : ''}`);
  }

  readonly retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : (this.props.children ?? null);
  }
}

/**
 * The fallback of a page (the app's boundary around each route): 'Try again' first. On the Live page the live
 * controls are the page itself, so it says what still works there (the screens, the keys and pedals) instead
 * of pointing to the menu, which leads away from them (the 2026-11-13 review).
 */
export function PageError(props: { route: string; retry: () => void }) {
  const live = props.route === 'live';
  return (
    <div className="center">
      <div className="banner red col" role="alert" data-page-error={props.route} style={{ gap: 8 }}>
        <span>
          {live
            ? 'The live page could not be shown. The screens keep showing what is live, and the keyboard and pedals still work. Press Try again.'
            : 'This page could not be shown. The screens and the live controls are not affected: use the menu above to go on.'}
        </span>
        <button type="button" className="small" onClick={props.retry}>
          Try again
        </button>
      </div>
    </div>
  );
}

/** The fallback of an editor pane: what happened, that the screens are not affected, and a way back. */
export function PaneError(props: { what: string; retry: () => void; undo?: () => void }) {
  return (
    <div className="banner red col" role="alert" data-pane-error style={{ gap: 8, margin: 8 }}>
      <span>
        {props.what} could not be shown. The screens and the live controls are not affected. Undo the last
        change or open another slide, then try again.
      </span>
      <span className="row" style={{ gap: 6 }}>
        <button type="button" className="small" onClick={props.retry}>
          Try again
        </button>
        {props.undo && (
          <button type="button" className="small" onClick={props.undo}>
            Undo
          </button>
        )}
      </span>
    </div>
  );
}
