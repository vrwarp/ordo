import { useEffect } from 'react';
import { useLive } from '../../state/live.ts';
import { setUi, useUi } from '../../state/ui.ts';
import { DegradedBanner } from './DegradedBanner.tsx';
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx';
import { LayerBar } from './LayerBar.tsx';
import { ConflictDialog, GoLiveErrorDialog, LocalGoLiveDialog, PlacementDialog } from './LiveDialogs.tsx';
import { PlaylistPane } from './PlaylistPane.tsx';
import { ProgramView } from './ProgramView.tsx';
import { SlideGrid } from './SlideGrid.tsx';
import { StageTools } from './StageTools.tsx';
import { TopBar } from './TopBar.tsx';
import { useOperatorPlaylist } from './useOperatorPlaylist.ts';

/** The operator view (prd/02 Layout). */
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
      <div className="op-main">
        <PlaylistPane op={op} viewItem={viewItem} />
        <SlideGrid op={op} viewItem={viewItem} />
        <div className="pane">
          <ProgramView />
          <StageTools />
        </div>
      </div>
      <LayerBar op={op} />
      <PlacementDialog />
      <ConflictDialog />
      <GoLiveErrorDialog />
      <LocalGoLiveDialog />
      <DiagnosticsPanel />
    </div>
  );
}
