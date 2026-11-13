/**
 * The error boundary the editor puts around its canvas, panels and previews and the app around each page
 * (components/ErrorBoundary.tsx; design/15 "Errors"): a render error shows the pane's fallback instead of
 * unmounting the operator window, is logged, and a new `resetKey` (the slide after an undo, another page)
 * or 'Try again' draws the children again. (React's server renderer has no error boundaries: the class's
 * lifecycle is driven directly.)
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorBoundary, type ErrorBoundaryProps, PaneError } from '../src/components/ErrorBoundary.tsx';
import { logLines } from '../src/services/log.ts';

const props = (resetKey: unknown): ErrorBoundaryProps => ({
  name: 'editor canvas',
  resetKey,
  fallback: (retry) => createElement(PaneError, { what: 'This slide', retry }),
  children: createElement('b', null, 'canvas'),
});

describe('ErrorBoundary', () => {
  it('shows its children, and the fallback once a child threw', () => {
    const b = new ErrorBoundary(props(1));
    Object.assign(b.state, ErrorBoundary.getDerivedStateFromProps(b.props, b.state));
    expect(renderToStaticMarkup(b.render() as never)).toBe('<b>canvas</b>');
    Object.assign(b.state, ErrorBoundary.getDerivedStateFromError());
    const html = renderToStaticMarkup(b.render() as never);
    expect(html).toContain('This slide could not be shown');
    expect(html).toContain('The screens and the live controls are not affected');
    expect(html).toContain('role="alert"');
  });

  it('a new reset key draws the children again; the same one keeps the fallback', () => {
    const b = new ErrorBoundary(props('slide-a'));
    Object.assign(b.state, ErrorBoundary.getDerivedStateFromProps(b.props, b.state));
    Object.assign(b.state, ErrorBoundary.getDerivedStateFromError());
    expect(ErrorBoundary.getDerivedStateFromProps(props('slide-a'), b.state)).toBeNull();
    expect(ErrorBoundary.getDerivedStateFromProps(props('slide-b'), b.state)).toEqual({
      key: 'slide-b',
      failed: false,
    });
  });

  it('logs what failed, where', () => {
    const b = new ErrorBoundary(props(1));
    b.componentDidCatch(new TypeError("Cannot read properties of undefined (reading 'length')"), {
      componentStack: '\n    at TextSection\n    at ObjectPanel',
    });
    expect(logLines().at(-1)).toMatchObject({
      level: 'error',
      text: "editor canvas: TypeError: Cannot read properties of undefined (reading 'length') (at TextSection)",
    });
  });
});
