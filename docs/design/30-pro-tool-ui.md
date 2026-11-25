# Design 30: Desktop pro-tool UX/UI overhaul

Packages and apps involved:

- `apps/operator`: design tokens, surface geometry, SVG icon set, custom desktop controls (`Select`, `DateField`, `NumberStepper`, `SplitPane`, `PropertyRow`), top chrome (`Nav`, `TopBar`), and view-level desktop workspaces across `Live`, `Playlists`, `Library`, `Editor`, `Settings`, `Setup`, and `Auth`/`Dialogs`.
- `apps/operator/test` and `e2e`: updated desktop style invariants (`styles.test.ts`), preserved iPad 44 px touch-target audits (`e2e/ipad/touch-targets.spec.ts`), preserved compact bundle/path boundaries (`tools/bundle-report.mjs`, `pageSets.ts`).

## 1. Goal & guiding principle

Shift `ordo` on desktop (`layout === 'regular'` with a fine pointer) away from SaaS/admin web conventions and toward a **pro-AV desktop instrument** (comparable in tactile feel and density to ProPresenter, DaVinci Resolve, and Figma), **without altering the route/page split** (`Playlists`, `Library`, `Live`, `Settings`, `Setup`, `Edit`) or breaking touch/mobile surfaces.

**The rule:** Every pixel on desktop must read as a **docked, direct-manipulation control surface**, never a scrolling HTML settings document or a logged-in website.

---

## 2. Hard invariants & non-regression rules

1. **Existing route split stays intact.** `#/playlists`, `#/library/*`, `#/live`, `#/settings/*`, `#/setup`, `#/checklist`, `#/previews`, and `#/edit/:id` keep their URLs, lazy chunk boundaries (`apps/operator/src/pages.ts`), and role/capability gates (`apps/operator/src/lib/route.ts`).
2. **Phone (`compact`) is untouched.** `apps/operator/src/compact.css`, `views/compact/*`, and `COMPACT_FORBIDDEN` bundle boundaries (`tools/bundle-report.mjs`, `apps/operator/test/compactImports.test.ts`) must not regress. Any new desktop-only primitives (`SplitPane`, desktop `Select` popover, media grid zoom) must stay out of `compact` or stay lightweight within the 8 % `bundle-baseline.json` budget.
3. **iPad / tablet (`@media (pointer: coarse)`) preserves 44×44 px targets.** Every interactive control audited by `e2e/touchaudit.ts` (`e2e/ipad/touch-targets.spec.ts` and `e2e/ipad/table-targets.spec.ts`) continues to expand to `>= 44×44 px` under `@media (pointer: coarse)`, and hover-only affordances on desktop stay visible or reachable under `pointer: coarse`.
4. **WCAG AA contrast holds.** `--fg3` (`.muted`) maintains `>= 4.5:1` contrast against `--bg`, `--bg2`, `--bg3`, and `--bg4` (`apps/operator/test/styles.test.ts`).
5. **Live keyboard & modal safety (`design/15` §Keyboard).** Custom popovers (`Select`, session menu, date picker, arrangement popover) must register with `components/popupOf.ts` (`usePopupOf` / `registerPopup`) and respect `data-keys="off"` when editing text or open inside a modal, so `Space`, `Escape`, `F1–F8`, and arrow keys never leak to live outputs or get swallowed unexpectedly.
6. **Existing `data-*` E2E hooks remain stable.** Keep `data-demo-banner`, `data-unsaved-pill`, `data-live-chip`, `data-edit-device-note`, `data-live-status`, `data-hub-status`, `data-launch`, `data-playlist-slide-preview`, `data-hotfix-card`, `data-live-speaker-notes`, `data-pptx-import-mode`, etc. intact across refactored components.

---

## 3. Visual foundation & design tokens (`apps/operator/src/styles.css`)

### 3.1 Palette & surfaces

Keep `ordo`'s cool dark-slate hue family and blue accent, while eliminating rounded nested `.card` containers:

| Token / Element                       | Current                                                                          | Target (Desktop `pointer: fine`)                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--bg` (canvas / recessed wells)      | `#0e1013`                                                                        | `#0e1013`                                                                                                                                |
| `--bg2` (docked panes / toolbars)     | `#15181d`                                                                        | `#15181d`                                                                                                                                |
| `--bg3` (headers / raised controls)   | `#1c2027`                                                                        | `#1c2027`                                                                                                                                |
| `--bg4` (button fills / active tabs)  | `#252a33`                                                                        | `#252a33`                                                                                                                                |
| `--line` (pane splitters & hairlines) | `#2d333d`                                                                        | `#262b34` (crisp `1px` flush dividers; `--line-strong: #333a46` on inputs/buttons)                                                       |
| `--accent` / `--accent2`              | `#3b82f6` / `#2563eb`                                                            | `#3b82f6` / `#2563eb` (reserved for active selection, focused rings, and primary mode/action emphasis — never repeated across list rows) |
| Pane geometry                         | Padded `.card` (`border-radius: 10px`, `padding: 14px`) inside scrolling `.page` | **Flush `0px`-radius docked panes** separated by `1px` hairlines; zero "boxes inside boxes"                                              |
| Control & thumb radii                 | `--radius: 8px`, `.card: 10px`, `.tag: 9999px`                                   | `--radius: 3px` (`4px` max on thumbnails/dialogs; **no `9999px` pill badges** — badges use `3px` radius)                                 |
| Scrollbars                            | Unstyled browser scrollbars                                                      | Custom thin dark scrollbars (`scrollbar-width: thin`, `6px` WebKit thumb in `#2f3642`, transparent track)                                |

### 3.2 Typography & desktop control density

Gate compact sizing to desktop (`pointer: fine`), keeping `@media (pointer: coarse)` at 44 px:

| Metric                                                                                    | Current                                            | Target (`pointer: fine`)                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base UI font size                                                                         | `14px`                                             | `12.5px` (`11px` section headers/badges, `12px` controls/lists, tabular numerals `font-variant-numeric: tabular-nums` on all clocks/timers/indices/dB)                           |
| Standard button / input / select height                                                   | `36–40px` (`min-height: 36px` everywhere in `.op`) | `27px` (`24px` `.small` / icon-only toolbar buttons)                                                                                                                             |
| Tactical live-fire targets (`Go Live`, `LayerBar` tally keys, `Clear All`, `End Service`) | `36–40px`                                          | `34–36px` (update `apps/operator/test/styles.test.ts` to assert `>= 34px` on tactical live-fire controls rather than every `<select>`/`<input>` in `.op`)                        |
| List / rundown row height (`.pl-item`, library rows)                                      | `46–52px`                                          | `32px` (`30px` dense library/add rows)                                                                                                                                           |
| DOM text selection                                                                        | Selectable across labels/chrome                    | `user-select: none` on `.app` chrome; `user-select: text` enabled explicitly on `input`, `textarea`, `[contenteditable]`, `.live-notes-body`, `.logbox`, and diagnostics figures |

### 3.3 Unified SVG iconography (`components/Icons.tsx`)

- Replace **all** Unicode/emoji UI glyphs (`♪`, `⚙`, `💡`, `✕`, `▶`, `❚❚`, `⟲`, `↑`, `↓`, `▸`, `▾`, `⌫`, `♫`) with a single zero-dependency `components/Icons.tsx` sprite/component set (`14px` / `16px` viewBox, `1.5px` stroke, `currentColor`).
- Include crisp icons for:
  - Navigation modes: `Playlists`, `Library`, `Live` (signal/broadcast), `Settings` (sliders/gear), `Setup` (displays/check), `Previews`.
  - Item & asset kinds: `Song`, `Slides/Deck`, `Loop`, `Video`, `Image`, `Audio`, `Timer`, `Action`, `Folder`, `Tag`, `Theme`, `Font`.
  - Transport & layers: `Play`, `Pause`, `Restart`, `Background`, `SlideLayer`, `BannerLayer`, `MediaLayer`, `PropsLayer`, `Lighting`, `AudioSpeaker`, `Mute`, `ClearAll`.
  - Workspace chrome: `GridView`, `ListView`, `Arrange`, `Inspector`, `Plus`, `Close`, `ChevronRight`, `ChevronDown`, `DragGrip`, `ExternalWindow`, `UserSession`, `Search`.

### 3.4 Resizable split-pane primitive (`components/SplitPane.tsx`)

- Add a lightweight desktop `<SplitPane storageKey="..." columns={[...]} min={[...]} max={[...]} />` (horizontal and vertical variants).
- Renders a `1px` `--line` divider with an invisible `5px` hit zone (`cursor: col-resize` / `row-resize`), highlights in `--accent` on drag/hover, persists sizes to `localStorage` (`ordo.split.<key>`), and **resets to default widths on double-click**.
- Disabled automatically on `compact` and narrow responsive breakpoints.

### 3.5 Custom desktop controls & 2-column property inspector (`components/fields.tsx`)

- **2-column `PropertyRow` (`label` left, control right):** Replace stacked `<label class="field">` + `100%`-width inputs across `ItemSettings`, `Editor` panels (`ObjectPanel`, `SlidePanel`, `PresentationPanel`), `Library` inspectors, and `Settings` pages. Left label column (`110–140px` muted `12px` text, optional tooltip hint), right control slot (`flex: 1`, `max-width: 220px` or right-aligned compact toggle/select).
- **Eliminate prose paragraphs in forms:** Move multi-sentence explanations (e.g. `Fires once when entering this item...`, `Starting this loop can automatically start...`) into concise `title` / info-icon tooltips or single-line `11px` subdued status hints.
- **Custom dark `<Select>` popover:** On desktop (`pointer: fine`), render `<Select>` as a `27px` button + dark portal popover list registered via `usePopupOf` (keyboard type-ahead, Up/Down/Enter/Escape, checkmark on active item), eliminating jarring OS-native `<select>` menus. Keep native `<select>` on `@media (pointer: coarse)` / `compact` where iOS/iPadOS wheel/sheet pickers are expected.
- **Custom `<Checkbox>` & `<SegmentedControl>`:** Styled `15×15px` crisp dark checkboxes (`3px` radius) and flush `26px` segmented toggle groups (`Songs | Media | Cues`, `Grid | List`, etc.).
- **Custom `<DateField>` & `<NumberStepper>`:** Replace raw browser `<input type="date">` (`mm/dd/yyyy`) with a clean formatted date trigger + compact dark calendar popover (with "Next Sunday" quick action). Hide WebKit/Firefox `<input type="number">` spin buttons (`appearance: textfield`), offering compact `−` / `+` steppers or drag-scrubbing where appropriate.
- **Shortcut badges (`<Kbd>`):** Render keyboard shortcuts (`Esc`, `F1`, `F2`, `Ctrl+Shift+L`) in uniform `10.5px` monospace keycaps inside menus, layer keys, and tooltips.

---

## 4. Global shell & top chrome (`views/Nav.tsx`, `views/live/TopBar.tsx`)

### 4.1 Application mode bar (`Nav.tsx`, `36px` height)

- Replace the `48px` SaaS navbar with a `36px` desktop instrument bar (`background: var(--bg2)`, `border-bottom: 1px solid var(--line)`):
  - **Left:** Compact `ordo` monogram/title (`12.5px` bold) + subtle `3px`-radius `DEMO` badge (`data-demo-banner`) when in demo mode.
  - **Center-left:** Segmented workspace tabs with `14px` SVG icons + labels (`Playlists`, `Library`, `Live` with live tally dot when on air, `Settings`, `Setup`), styled as recessed/active tool tabs (`26px` height, `3px` radius) rather than web hyperlinks.
  - **Right:** `UnsavedNavControl` (`data-unsaved-pill`), `LiveChip` (`data-live-chip` on edit profile), offline indicator, and a **single compact Session Menu button** (`[Operator ▾]` / user-shield icon) whose dark popover houses `Role: Operator / Editor`, `Edit-only device` note, and `Sign out` (removing permanent `Role:` pill + `Sign out` text clutter from the top bar).

### 4.2 `Live` telemetry & tally strip (`TopBar.tsx`, `36px` height)

- Condense `TopBar` from `52px` two-line stacked text into a single structured `36px` broadcast telemetry bar:
  - **Left:** Crisp tally badge (`ON AIR` red lit / `STANDBY` recessed, `data-live-status`) + inline active playlist title (`Sample service`, no redundant second line of `Not live` / `—`).
  - **Center:** Structured hardware-style status cells separated by `1px` vertical dividers: Hub link (`data-hub-status`), `WAN`, `Cache %`, per-output health LEDs (`Audience 1`, `Stream`, `Stage`), plus alert badges (`red` / `amber` budget/stall/fallback actions).
  - **Right:** Tabular `15px` clock (`6:40 AM`), compact `Launch outputs` / `Relaunch` buttons (`data-launch`, with icon + shortcut tooltip), `End service` (when live), and `Diagnostics` SVG icon trigger.

---

## 5. View-by-view UX/UI specifications

### 5.1 `Live` operator view (`views/live/*`)

Resizable 3-column split (`SplitPane` default `260px | 1fr | 340px`, min `200px | 420px | 280px`) above the bottom `LayerBar`:

1. **Left — `PlaylistPane.tsx` (Rundown):**
   - Flush pane header (`32px`): compact Playlist `<Select>` dropdown + icon buttons for `New`, `Duplicate`, and `Edit in Playlists` (no stacked multi-row header).
   - When not live, a sleek `34px` primary `Go Live` bar (`Go live` + readiness status inline) rather than a giant full-width web CTA + separate readiness strip.
   - `32px` rundown rows: index, SVG kind icon, title + compact arrangement/subtitle inline, hover-only `✕` on desktop when off-air, crisp red left tally bar + subtle red tint when On Air.
   - Footer: compact `+ Add item…` bar toggling the inline quick-insert drawer.

2. **Center — `SlideGrid.tsx` & `SlideThumb.tsx` ( Cue Canvas ):**
   - **Compact `32px` canvas toolbar:** Item title on left; right side replaces oversized browser checkboxes (`[✓] Click = GO`, `[✓] Follow live`) and raw range slider with compact toggle pills (`Click=GO`, `Follow`) + a sleek thumbnail zoom icon/slider (`140px–280px`) + an **`Arrange` toggle button** (which reveals/collapses `InlineArrangementStrip` on demand instead of permanently burning vertical space on every song).
   - **Continuous multi-column slide flow:** Within each presentation item, render **one unified `.slide-grid`** across all sections instead of breaking every section onto a new vertical row (eliminating the 1-slide-per-row vertical ladder and 75 % empty void).
   - **ProPresenter-style color-coded section bands:** Assign deterministic, tasteful section accent colors (`Verse` = blue `#2563eb`, `Chorus` = rose/crimson `#be123c`, `Pre-Chorus` = indigo `#4f46e5`, `Bridge` = amber `#b45309`, `Tag / Outro` = teal `#0f766e`, `Intro / Instr` = violet `#6d28d9`, `Loop / Misc` = slate `#3f4756`). Fuse the color-coded footer bar (`[V1] Verse 1` on the first slide of a section, continuation bar on subsequent slides of that section) directly onto the bottom of `SlideThumb` (`3px` outer radius). Clicking/context-clicking the section badge retains section-jump / section-arm behavior (`prd/02` §Navigation).
   - **Alpha checkerboard on transparent slides:** Behind `.thumb .img` / `.fallback-text` when a slide has no opaque background or media backdrop, render a subtle dark two-tone checkerboard (`#14171c` / `#1b1f26`, `8px` grid) so transparent lyric slides read as keyable overlays rather than flat black boxes.

3. **Right — `ProgramView.tsx` + `StageTools.tsx` (Zero-scroll Monitor & Stage Dock):**
   - **Top (`ProgramView`):** Eliminate the 3-high vertical stack of full-width 16:9 boxes that pushes Stage Tools off-screen:
     - Render **1 primary 16:9 Program monitor** on top (defaulting to the primary Audience output, or click any secondary monitor to swap/pin) flanked on its right edge by **live dual-channel vertical LED VU meters** (fed from `masterHealth.meters`).
     - Immediately below the primary monitor, render remaining enabled outputs (`Stream`, `Stage`, etc.) in a **compact 2-up horizontal grid** (`16:9` mini-monitors with health LED + name overlay).
     - Replace plain `"Output not open"` centered text with a subtle recessed monitor state (offline screen icon + `Offline` / `Standby` caption).
   - **Bottom (`StageTools` + `LiveSpeakerNotesCard`):** Fixed flex region organized into **4 flush segmented tabs** (`Stage Msg` | `Timers` | `Banner & Logo` | `Notes`), each displaying an active dot badge when live (e.g. active stage message, running timer, live lower-third, or current slide cue notes). Inside each tab, controls use compact `27px` inputs, 1-click preset chips, and tabular countdown readouts — zero right-rail overflow on `1080p` displays.

4. **Bottom — `LayerBar.tsx` (`46px` Tactical Switcher Strip):**
   - Replace the `72px` row of five 3-line `.chip` cards with a single `46px` broadcast console bar:
     - **Layer tally keys (`36px` height):** Five side-by-side hardware-style keys (`BG`, `Slide [F1]`, `Banner [F3]`, `Media`, `Props [F4]`), plus `Lights` preset trigger when MIDI is active. Idle keys sit recessed (`--bg3`, muted icon + label); live keys illuminate (`#10261a` / `#15803d` border + green tally LED + truncated active cue title + `✕` clear affordance). Clicking a live key clears that layer; right-clicking opens layer actions.
     - **Inline Media Transport:** Compact `[▶/❚❚]` `[⟲]` icon buttons + thin scrub/progress bar + tabular `00:00 / -00:00` readout.
     - **Master Audio trim:** Compact `−` `0 dB` `+` `Mute` strip.
     - **`CLEAR ALL [F2]` panic key (`36px` height):** Tactile crimson key on far right with an animated `1 s` hold-progress fill bar across the button face when held (`HoldGuard`).

---

### 5.2 `Playlists` prep view (`views/playlists/*`)

Replace the scrolling stacked-card center document with a **fixed 4-pane desktop workspace** (`SplitPane` default `190px | 250px | 1fr | 270px`; on viewports `< 1180px`, Col 1 collapses into a header dropdown selector):

1. **Col 1 — Playlists Sidebar (`~190px`):**
   - Flush header (`Playlists` + `+` icon button opening inline name field or creating next Sunday's service) + `32px` list rows showing playlist name, short date, item count, and live dot.
2. **Col 2 — Service Rundown (`~250px`):**
   - Flush header with inline editable playlist title, compact `<DateField>` (`Sun Nov 29`), readiness LED (`Ready · 5`), `Go Live` button, and `⋯` menu (`Open on Live`, `Duplicate`, `Delete`, `Offline`).
   - `32px` draggable rundown rows (`PlaylistItemRowContent`) — **no 700px-wide empty space**, and desktop `↑ ↓ ✕` buttons hidden until row hover/focus (kept visible under `@media (pointer: coarse)`). Supports `Delete` / `Backspace` key to remove selected off-air item and drag-and-drop from Col 4.
3. **Col 3 — Selected Item Workspace (`1fr`, vertical `SplitPane`):**
   - **Top pane (`SelectedItemSlidePreview`):** Flush toolbar (`Slide preview · <Title> (N cues)`, `Arrange` toggle for songs, `Edit slides…` button) over the continuous multi-column color-coded `SlideThumb` grid.
   - **Bottom pane (`ItemSettings` Inspector):** Docked scrollable inspector using **2-column `PropertyRow`s** (`Arrangement`, `Transition`, `Background` swatch + picker, `Keep previous bg`, `Lighting / MIDI`, `Pre-service loop` compact rows) — zero `.card` wrappers, zero 700px `<select>` bars, zero multi-sentence prose blocks.
4. **Col 4 — Library / Insert Browser (`AddItemsPanel.tsx`, `~270px`):**
   - Flush header with **3 segmented tabs**: `Songs` | `Media` | `Cues` (moving `Timer` and `Action` insertion out of the permanently pinned bottom stack into `Cues`!).
   - Search bar with SVG search + clear icon.
   - `30px` dense result rows: **double-click** or **drag into Col 2** to insert; subtle icon-only `+` button revealed on hover/focus (eliminating the column of bright primary-blue `Add` CTA buttons). Right-click context menu and chevron slide-preview roll remain available.

---

### 5.3 `Library` view (`views/library/*`)

- **Top sub-bar (`34px`):** Flush segmented/tab strip (`Presentations`, `Media`, `Themes`, `Fonts`, `Import`) with SVG icons + unsaved dots, plus contextual right-aligned toolbar controls (`Search`, `Grid / List` toggle, zoom slider, `+ New` / `+ Import` action buttons).
- **`PresentationsTab.tsx`:** 3-pane `SplitPane` (`190px` Folders & Tags tree | `1fr` dense sortable presentation table/list with hover actions instead of row button clutter | `320px` docked right Preview & Metadata Inspector showing slide thumbnails, arrangements, CCLI/tags, and `Edit slides` button).
- **`MediaTab.tsx`:**
  - Default to a **visual 16:9 thumbnail grid** (like ProPresenter's Media Bin, with `Grid | List` toggle and thumbnail size slider in the header).
  - Remove the permanent dashed `Drop files here` web banner; instead support **whole-pane drag-and-drop** (showing a clean drop overlay only while dragging files over the window) plus a compact `+ Import Media` button in the header (`coarse` pointer keeps `Choose files` in header).
  - Move all per-row inline form controls (`Background` checkbox, `Loop` checkbox, `Bg lighting` select, `Audio pair` select, `Gain dB` input) out of the grid/list items into a **docked right-side Media Inspector (`280px`)** using 2-column `PropertyRow`s + a playable 16:9 preview monitor at the top of the inspector.
- **`ThemesTab.tsx`, `FontsTab.tsx`, `ImportTab.tsx`:** Convert `.card` stacks into flush split panes (`Themes` list | Theme canvas | 2-column `PropertyRow` inspector; `Import` split between structured source/options left pane and active import jobs/logs right pane).

---

### 5.4 `Editor` view (`views/editor/*`)

- Keep `EditorView`'s existing desktop canvas-first / docked architecture and all `e2e/editor-*.spec.ts` + `e2e/ipad/touch-targets.spec.ts` behaviors, applying the pro-tool surface and inspector pass on `pointer: fine`:
  - Wrap left `SlidesPanel` and right `props` inspector (`ObjectPanel`, `SlidePanel`, `PresentationPanel`) in draggable `1px` `SplitPane` dividers.
  - Convert inspector controls inside `ObjectPanel`, `SlidePanel`, `PresentationPanel`, and `TableTools` to compact `27px` 2-column `PropertyRow`s on `pointer: fine` while preserving `>= 44×44 px` rules inside `@media (pointer: coarse)`.
  - Replace Unicode symbols in `EditorView`, `FormatBar`, `FloatingContextBar`, and `SlidesPanel` with `components/Icons.tsx`.

---

### 5.5 `Settings`, `Setup`, `Auth` & `Dialogs`

- **`SettingsView.tsx` (`views/settings/*`):** Style as a native desktop Preferences window — `190px` left category list with SVG icons (`Screens`, `Looks`, `Audio`, `Keyboard`, `Stream Deck`, `MIDI`, `Stage messages`, `General`, `PINs`, `Backups`, `Diagnostics`) + structured preference sections using `1px` hairline dividers and 2-column `PropertyRow`s (`max-width: 760px` clean grid, no floating `.card` boxes).
- **`DeviceSetupView.tsx` (`views/setup/*`):** Compact diagnostic readiness table/checklist rows with LED status indicators and right-aligned action buttons instead of stacked web cards.
- **`LoginView.tsx` & `Dialog.tsx`:** Tighter `4px`-radius dialog frames (`--bg2`, `1px solid var(--line-strong)`, crisp `36px` header bar, `27px` footer buttons with `<Kbd>` hints), sleek console keypad for `RegularLoginView` (`PhoneLoginView` untouched).

---

## 6. Milestone implementation roadmap

Each phase leaves `pnpm typecheck`, `pnpm lint`, unit tests (`pnpm test`), `node tools/bundle-report.mjs --check`, and Playwright specs green before advancing.

### Phase 1: Design tokens, SVG icon system & core desktop primitives

- Add `apps/operator/src/components/Icons.tsx` (complete stroke SVG icon set).
- Add `apps/operator/src/components/SplitPane.tsx` (persisted `1px` resizable splitters + double-click reset).
- Upgrade `apps/operator/src/components/fields.tsx`: `PropertyRow`, desktop custom `<Select>` (`usePopupOf`-registered), `<SegmentedControl>`, `<DateField>`, `<NumberStepper>`, `<Kbd>`, and styled `<Checkbox>`.
- Update `apps/operator/src/styles.css` (`pointer: fine` compact sizing `12.5px` / `27px` controls / `3–4px` radii / flush panes / thin scrollbars / `user-select: none`, preserving `@media (pointer: coarse)` 44 px overrides and `--fg3` 4.5:1 contrast).
- Update `apps/operator/test/styles.test.ts` for tactical live-fire control heights (`>= 34px`) + contrast checks; add unit tests for `SplitPane` and desktop `Select`.

### Phase 2: Global shell & `Live` operator console (Screenshot 1)

- Refactor `views/Nav.tsx` (`36px` SVG mode tabs + compact Session Menu popover).
- Refactor `views/live/TopBar.tsx` (`36px` structured broadcast tally/telemetry strip).
- Refactor `views/live/LiveView.tsx` & `PlaylistPane.tsx` (`SplitPane` columns, `32px` rundown rows, streamlined `Go Live` header).
- Refactor `views/live/SlideGrid.tsx` & `SlideThumb.tsx` (continuous multi-column slide flow, ProPresenter-style color-coded section bands, dark alpha-checkerboard on transparent slides, collapsible `Arrange` strip, compact toolbar pills).
- Refactor `views/live/ProgramView.tsx` & `StageTools.tsx` (1 primary monitor + dual vertical LED VU meters + 2-up secondary monitors + 4 flush segmented Stage Tool tabs — zero right-rail scroll).
- Refactor `views/live/LayerBar.tsx` (`46px` tactical console strip with `36px` illuminated tally keys, inline media progress/timecode, compact audio trim, and hold-progress `CLEAR ALL [F2]`).

### Phase 3: `Playlists` 4-pane desktop workspace (Screenshot 2)

- Refactor `views/playlists/PlaylistsView.tsx` & `PlaylistEditor.tsx` into the fixed 4-pane `SplitPane` layout (`Playlists` | `Rundown` | `Slide Preview + Docked Inspector` | `Library/Insert`).
- Convert `views/playlists/ItemSettings.tsx` into 2-column `PropertyRow`s with custom selects/date/time controls and concise tooltips.
- Refactor `views/playlists/AddItemsPanel.tsx` (`Songs | Media | Cues` segmented tabs, double-click + drag-to-rundown insertion, hover-only `+` icon).

### Phase 4: `Library` asset browser & `Editor` / `Settings` / `Setup` alignment

- Refactor `views/library/LibraryView.tsx`, `MediaTab.tsx` (16:9 thumbnail grid + zoom + whole-pane drop + docked right Media Inspector), `PresentationsTab.tsx` (master-detail preview/inspector split), `ThemesTab.tsx`, `FontsTab.tsx`, and `ImportTab.tsx`.
- Apply `SplitPane`, SVG icons, and `pointer: fine` 2-column `PropertyRow`s across `views/editor/*` (`EditorView`, `ObjectPanel`, `SlidePanel`, `PresentationPanel`, `FormatBar`).
- Convert `views/settings/*`, `views/setup/DeviceSetupView.tsx`, `views/auth/LoginView.tsx`, and `components/Dialog.tsx` to flush desktop preferences/dialog styling.
- Full verification pass: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `node tools/bundle-report.mjs --check`, desktop E2E (`operator.spec.ts`, `live-frame.spec.ts`, `playlist-continuous-scroll.spec.ts`, `editor-*.spec.ts`), iPad touch audit (`e2e/ipad/touch-targets.spec.ts`), and phone specs (`e2e/phone/*`).
