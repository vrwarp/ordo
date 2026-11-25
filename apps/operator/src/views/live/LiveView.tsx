import { useEffect } from 'react';
import { SplitPane } from '../../components/SplitPane.tsx';
import { useLive } from '../../state/live.ts';
import { setUi, useUi } from '../../state/ui.ts';
import { DegradedBanner } from './DegradedBanner.tsx';
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx';
import { LayerBar } from './LayerBar.tsx';
import { GoLivePrepareToast } from './GoLiveToast.tsx';
import { ConflictDialog, GoLiveErrorDialog, LocalGoLiveDialog, PlacementDialog } from './LiveDialogs.tsx';
import { PlaylistPane } from './PlaylistPane.tsx';
import { ProgramView } from './ProgramView.tsx';
import { SlideGrid } from './SlideGrid.tsx';
import { StageTools } from './StageTools.tsx';
import { TopBar } from './TopBar.tsx';
import { useOperatorPlaylist } from './useOperatorPlaylist.ts';

/** The operator view (prd/02 Layout, design/30 §5.1). */
export function LiveView() {
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
      <TopBar />
      <DegradedBanner />
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
