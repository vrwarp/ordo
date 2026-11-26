import { useEffect } from 'react';
import { Kbd } from '../../components/fields.tsx';
import { useCoarsePointer } from '../../components/pointer.ts';
import { SplitPane } from '../../components/SplitPane.tsx';
import { dispatch } from '../../services/controller.ts';
import { useLive } from '../../state/live.ts';
import { setUi, useUi } from '../../state/ui.ts';
import { DegradedBanner } from './DegradedBanner.tsx';
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx';
import { GoLivePrepareToast } from './GoLiveToast.tsx';
import { LayerBar } from './LayerBar.tsx';
import { ConflictDialog, GoLiveErrorDialog, LocalGoLiveDialog, PlacementDialog } from './LiveDialogs.tsx';
import { PlaylistPane } from './PlaylistPane.tsx';
import { ProgramView } from './ProgramView.tsx';
import { SlideGrid } from './SlideGrid.tsx';
import { StageTools } from './StageTools.tsx';
import { TopBar } from './TopBar.tsx';
import { useOperatorPlaylist } from './useOperatorPlaylist.ts';

function HoldBlankBanner() {
  const active = useLive((s) => s.state.mode === 'live' && Boolean(s.state.blankText));
  if (!active) return null;
  return (
    <div
      className="banner row"
      role="status"
      data-hold-blank-banner
      style={{
        margin: '6px 12px',
        padding: '7px 12px',
        alignItems: 'center',
        gap: 12,
        background: 'rgba(245, 158, 11, 0.16)',
        border: '1px solid rgba(245, 158, 11, 0.55)',
      }}
    >
      <span className="grow">
        <b>Audience text is held blank</b> — backgrounds, MIDI cues, and Stage Display still advance, while
        audience &amp; livestream text stay hidden.
      </span>
      <button
        type="button"
        className="small primary"
        onClick={() => dispatch({ id: 'clearSlide' })}
        data-release-hold-blank
      >
        Show slide <Kbd>F1</Kbd>
      </button>
    </div>
  );
}

/** The operator view (prd/02 Layout, design/30 §5.1). */
export function LiveView() {
  const coarse = useCoarsePointer();
  const op = useOperatorPlaylist();
  const { followLive, viewItemIndex } = useUi();
  const liveItem = useLive((s) => {
    const i = s.state.live ?? s.state.armed;
    return i !== undefined ? s.state.cues[i]?.itemIndex : undefined;
  });
  const viewItem = followLive && op.live && liveItem !== undefined ? liveItem : (viewItemIndex ?? 0);
  useEffect(() => {
    if (followLive && op.live && liveItem !== undefined && liveItem !== viewItemIndex)
      setUi({ viewItemIndex: liveItem });
  }, [followLive, op.live, liveItem, viewItemIndex]);
  return (
    <div className="op">
      <TopBar inline={!coarse} />
      <DegradedBanner />
      <HoldBlankBanner />
      <SplitPane
        storageKey="live-main"
        className="op-main-split"
        panels={[
          {
            id: 'rundown',
            size: 280,
            min: 220,
            max: 440,
            content: <PlaylistPane op={op} viewItem={viewItem} />,
          },
          {
            id: 'slides',
            content: <SlideGrid op={op} viewItem={viewItem} />,
          },
          {
            id: 'program',
            size: 360,
            min: 290,
            max: 520,
            content: (
              <div className="op-right-rail">
                <SplitPane
                  storageKey="live-right-rail"
                  direction="vertical"
                  panels={[
                    {
                      id: 'monitors',
                      size: 410,
                      min: 220,
                      max: 680,
                      content: <ProgramView />,
                    },
                    {
                      id: 'stage-tools',
                      content: <StageTools />,
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />
      <LayerBar op={op} />
      <PlacementDialog />
      <ConflictDialog />
      <GoLiveErrorDialog />
      <div className="toasts golive no-print">
        <GoLivePrepareToast />
      </div>
      <LocalGoLiveDialog />
      <DiagnosticsPanel />
    </div>
  );
}
