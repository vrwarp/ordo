import type { Box, TextStyle } from '@ordo/domain';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';

export interface ThemeCanvasProps {
  box: Box;
  text: TextStyle;
  onChangeBox: (box: Box) => void;
  scenario: {
    id: string;
    label: string;
    primary: string;
    secondary?: string;
  };
}

type HandleKind = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface DragState {
  handle: HandleKind;
  startX: number;
  startY: number;
  initBox: Box;
}

export function ThemeCanvas({ box, text, onChangeBox, scenario }: ThemeCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});

  const startDrag = (handle: HandleKind, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      handle,
      startX: e.clientX,
      startY: e.clientY,
      initBox: { ...box },
    });
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const scaleX = 1920 / rect.width;
    const scaleY = 1080 / rect.height;

    const dx = (e.clientX - drag.startX) * scaleX;
    const dy = (e.clientY - drag.startY) * scaleY;

    let { x, y, w, h } = drag.initBox;
    const snapGuide: { x?: number; y?: number } = {};
    const SNAP_THRESH = 14;

    if (drag.handle === 'move') {
      x += dx;
      y += dy;

      // Snap horizontal center
      if (Math.abs(x + w / 2 - 960) < SNAP_THRESH) {
        x = 960 - w / 2;
        snapGuide.x = 960;
      }
      // Snap vertical center
      if (Math.abs(y + h / 2 - 540) < SNAP_THRESH) {
        y = 540 - h / 2;
        snapGuide.y = 540;
      }
      // Snap 5% safe margins
      if (Math.abs(x - 96) < SNAP_THRESH) {
        x = 96;
        snapGuide.x = 96;
      } else if (Math.abs(x + w - 1824) < SNAP_THRESH) {
        x = 1824 - w;
        snapGuide.x = 1824;
      }
      if (Math.abs(y - 54) < SNAP_THRESH) {
        y = 54;
        snapGuide.y = 54;
      } else if (Math.abs(y + h - 1026) < SNAP_THRESH) {
        y = 1026 - h;
        snapGuide.y = 1026;
      }

      // Clamp to screen bounds
      x = Math.max(0, Math.min(1920 - w, Math.round(x)));
      y = Math.max(0, Math.min(1080 - h, Math.round(y)));
    } else {
      // Resizing via handles
      if (drag.handle.includes('e')) {
        w = Math.max(200, drag.initBox.w + dx);
        if (Math.abs(x + w - 1824) < SNAP_THRESH) {
          w = 1824 - x;
          snapGuide.x = 1824;
        } else if (Math.abs(x + w - 960) < SNAP_THRESH) {
          w = 960 - x;
          snapGuide.x = 960;
        }
      }
      if (drag.handle.includes('s')) {
        h = Math.max(80, drag.initBox.h + dy);
        if (Math.abs(y + h - 1026) < SNAP_THRESH) {
          h = 1026 - y;
          snapGuide.y = 1026;
        } else if (Math.abs(y + h - 540) < SNAP_THRESH) {
          h = 540 - y;
          snapGuide.y = 540;
        }
      }
      if (drag.handle.includes('w')) {
        const candidateX = drag.initBox.x + dx;
        const candidateW = drag.initBox.w - dx;
        if (candidateW >= 200) {
          x = candidateX;
          w = candidateW;
          if (Math.abs(x - 96) < SNAP_THRESH) {
            w += x - 96;
            x = 96;
            snapGuide.x = 96;
          }
        }
      }
      if (drag.handle.includes('n')) {
        const candidateY = drag.initBox.y + dy;
        const candidateH = drag.initBox.h - dy;
        if (candidateH >= 80) {
          y = candidateY;
          h = candidateH;
          if (Math.abs(y - 54) < SNAP_THRESH) {
            h += y - 54;
            y = 54;
            snapGuide.y = 54;
          }
        }
      }

      x = Math.max(0, Math.round(x));
      y = Math.max(0, Math.round(y));
      w = Math.min(1920 - x, Math.round(w));
      h = Math.min(1080 - y, Math.round(h));
    }

    setGuides(snapGuide);
    onChangeBox({ ...box, x, y, w, h });
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (drag) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* released */
      }
      setDrag(null);
      setGuides({});
    }
  };

  // Convert coordinate percentages
  const leftPct = (box.x / 1920) * 100;
  const topPct = (box.y / 1080) * 100;
  const widthPct = (box.w / 1920) * 100;
  const heightPct = (box.h / 1080) * 100;

  // Text styling and color
  const c = text.color;
  const col = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a ?? 1})`;
  const shadow = text.shadow
    ? `${text.shadow.dx * 0.25}px ${text.shadow.dy * 0.25}px ${text.shadow.blur * 0.25}px rgba(${text.shadow.color.r}, ${text.shadow.color.g}, ${text.shadow.color.b}, ${text.shadow.color.a ?? 1})`
    : undefined;
  const stroke = text.outline
    ? `${Math.max(1, text.outline.width * 0.25)}px rgba(${text.outline.color.r}, ${text.outline.color.g}, ${text.outline.color.b}, ${text.outline.color.a ?? 1})`
    : undefined;

  const fontStack = [
    text.fontFamily,
    ...(text.fallbackFonts ?? []),
    'PingFang SC',
    'Noto Sans CJK SC',
    'Microsoft YaHei',
    'system-ui',
    'sans-serif',
  ]
    .filter(Boolean)
    .join(', ');

  const vAlign = text.valign === 'top' ? 'flex-start' : text.valign === 'bottom' ? 'flex-end' : 'center';

  return (
    <div className="col" style={{ gap: 8 }}>
      <div
        ref={stageRef}
        className="theme-canvas-stage"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 9',
          background: 'radial-gradient(ellipse at 50% 40%, #151d2a 0%, #07090e 100%)',
          borderRadius: 8,
          border: '1px solid var(--line)',
          overflow: 'hidden',
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        {/* Title-Safe 5% Margin Guide */}
        <div
          style={{
            position: 'absolute',
            left: '5%',
            top: '5%',
            width: '90%',
            height: '90%',
            border: '1px dashed rgba(255, 255, 255, 0.08)',
            pointerEvents: 'none',
          }}
          title="5% Title-Safe Margin"
        />

        {/* Snap Guide Lines */}
        {guides.x !== undefined && (
          <div
            style={{
              position: 'absolute',
              left: `${(guides.x / 1920) * 100}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: '#38bdf8',
              boxShadow: '0 0 6px #38bdf8',
              pointerEvents: 'none',
              zIndex: 10,
            }}
          />
        )}
        {guides.y !== undefined && (
          <div
            style={{
              position: 'absolute',
              top: `${(guides.y / 1080) * 100}%`,
              left: 0,
              right: 0,
              height: 1,
              background: '#38bdf8',
              boxShadow: '0 0 6px #38bdf8',
              pointerEvents: 'none',
              zIndex: 10,
            }}
          />
        )}

        {/* The Interactive Bounding Box */}
        <div
          onPointerDown={(e) => startDrag('move', e)}
          style={{
            position: 'absolute',
            left: `${leftPct}%`,
            top: `${topPct}%`,
            width: `${widthPct}%`,
            height: `${heightPct}%`,
            border: drag ? '1.5px solid #38bdf8' : '1.5px dashed rgba(56, 189, 248, 0.7)',
            backgroundColor: drag ? 'rgba(56, 189, 248, 0.08)' : 'rgba(56, 189, 248, 0.03)',
            borderRadius: 4,
            cursor: 'move',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: vAlign,
            padding: `${Math.max(4, (text.padding ?? 20) * 0.25)}px`,
            boxSizing: 'border-box',
            zIndex: 5,
          }}
        >
          {/* Sample Typography (English + Chinese Bilingual) */}
          <div
            style={{
              fontFamily: fontStack,
              fontWeight: text.fontWeight ?? 600,
              fontStyle: text.fontStyle ?? 'normal',
              color: col,
              textAlign: text.align ?? 'center',
              lineHeight: text.lineHeight ?? 1.3,
              textShadow: shadow,
              WebkitTextStroke: stroke,
              fontSize: 'clamp(11px, 2.3vw, 24px)',
              pointerEvents: 'none',
              wordBreak: 'break-word',
            }}
          >
            <div>{scenario.primary}</div>
            {scenario.secondary && (
              <div
                style={{
                  marginTop: '4px',
                  fontSize: '0.85em',
                  opacity: 0.92,
                  fontWeight: Math.max(400, (text.fontWeight ?? 600) - 100),
                }}
              >
                {scenario.secondary}
              </div>
            )}
          </div>

          {/* 8 Resize Handles */}
          <Handle position="nw" cursor="nwse-resize" onStart={(e) => startDrag('nw', e)} />
          <Handle position="n" cursor="ns-resize" onStart={(e) => startDrag('n', e)} />
          <Handle position="ne" cursor="nesw-resize" onStart={(e) => startDrag('ne', e)} />
          <Handle position="e" cursor="ew-resize" onStart={(e) => startDrag('e', e)} />
          <Handle position="se" cursor="nwse-resize" onStart={(e) => startDrag('se', e)} />
          <Handle position="s" cursor="ns-resize" onStart={(e) => startDrag('s', e)} />
          <Handle position="sw" cursor="nesw-resize" onStart={(e) => startDrag('sw', e)} />
          <Handle position="w" cursor="ew-resize" onStart={(e) => startDrag('w', e)} />
        </div>

        {/* Live HUD info */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 10,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            fontSize: 11,
            color: 'rgba(255,255,255,0.6)',
            fontFamily: 'monospace',
            pointerEvents: 'none',
          }}
        >
          <span style={{ background: 'rgba(0,0,0,0.6)', padding: '2px 6px', borderRadius: 4 }}>
            Box: {box.w} × {box.h} at ({box.x}, {box.y})
          </span>
          {drag && (
            <span
              style={{
                background: 'rgba(56, 189, 248, 0.25)',
                color: '#38bdf8',
                padding: '2px 6px',
                borderRadius: 4,
              }}
            >
              {drag.handle === 'move' ? 'Dragging' : 'Resizing'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Handle({
  position,
  cursor,
  onStart,
}: {
  position: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
  cursor: string;
  onStart: (e: ReactPointerEvent) => void;
}) {
  const size = 9;
  const style: React.CSSProperties = {
    position: 'absolute',
    width: size,
    height: size,
    backgroundColor: '#38bdf8',
    border: '1.5px solid #0f172a',
    borderRadius: 2,
    cursor,
    boxShadow: '0 0 4px rgba(0,0,0,0.8)',
    zIndex: 10,
  };

  switch (position) {
    case 'nw':
      style.top = -size / 2;
      style.left = -size / 2;
      break;
    case 'n':
      style.top = -size / 2;
      style.left = `calc(50% - ${size / 2}px)`;
      break;
    case 'ne':
      style.top = -size / 2;
      style.right = -size / 2;
      break;
    case 'e':
      style.top = `calc(50% - ${size / 2}px)`;
      style.right = -size / 2;
      break;
    case 'se':
      style.bottom = -size / 2;
      style.right = -size / 2;
      break;
    case 's':
      style.bottom = -size / 2;
      style.left = `calc(50% - ${size / 2}px)`;
      break;
    case 'sw':
      style.bottom = -size / 2;
      style.left = -size / 2;
      break;
    case 'w':
      style.top = `calc(50% - ${size / 2}px)`;
      style.left = -size / 2;
      break;
  }

  return <div style={style} onPointerDown={onStart} />;
}
