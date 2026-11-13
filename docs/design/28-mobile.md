# Design 28: ordo on phones

Packages and apps involved:

- `apps/operator`: a compact layout of the edit profile, phone-first views, drafts and a phone cache.
- `apps/hub`: session caps, two small socket messages, preview renditions, playlist revisions, pacing of
  jobs and uploads while live, upload hygiene.
- `packages/domain`: per-service fields on playlist items, `updatedBy`, `Playlist.serviceTime`,
  `Media.preview`, playlist operations, plan readiness.
- `packages/protocol`: the `venue` and `library.poke` messages.
- `e2e`: phone projects in WebKit and Chromium.

Status: proposed (2026-11-07). No code exists for it. It was written after three competing proposals, a
synthesis and a completeness review of that synthesis against the code at `8ea4456` (§15 lists what the
review changed). Mockups of the key screens are in [28-mobile/](28-mobile/): static HTML in the operator's
colours, rendered with Playwright at 390x844 (iPhone) and 360x800 (Android), at 2x.

The church's tech lead set the scope: **a phone is used outside the service**. What matters is to **view the
library** (songs, presentations, plans, media, with search and slide previews as they will look) and to
make **light changes** (fix a typo or a lyric line, reorder or add a song to a plan, change an arrangement,
hide or duplicate a slide, swap a background or picture from the camera roll, add an announcement slide
from a template, edit a stage note), safely, from home or anywhere, over the public hostname. Live control,
a phone remote, GO or Next on a phone, a confidence or stage view on a phone and an audience lyrics feed
are out of scope (§11). The Live now indicator and the lock of the live playlist's presentations stay.

**The rule volunteers can repeat: a phone can look at everything and change a little. It never changes
what is live.**

## Today

- A phone that signs in gets the edit profile (design/15 "Capability profile"), with the iPad's views.
  Measured with Playwright WebKit at 390x844 and Chromium at 360x800 (2026-11-07): the shell grows to the width of the
  nav (446 to 759 px on a 390 px screen); the library keeps a 180 px folder column; dialogs have
  `min-width: 380px` (`apps/operator/src/styles.css:346-356`); the library search is focused on open,
  which pans Android Chrome sideways; the canvas editor gives the slide 312 px with handles over the lyric
  box; the Live now chip sits off-screen.
- With the operate PIN a phone gets an operate session. The edit profile never offers live control, but
  the hub accepts `live.event` from any operate socket (`apps/hub/src/ws.ts:415-417` refuses only `edit`)
  and `POST /live/events` from any operate cookie.
- "Remember this device" is ticked by default (`apps/operator/src/views/auth/LoginView.tsx:12`), so a phone
  keeps a one-year device cookie and 12-hour sessions (`apps/hub/src/routes.ts:359-366`).
- Offline, the app opens the library copy with the last role from `localStorage`, with no PIN and no time
  limit (`apps/operator/src/state/session.ts:24-48`). Sign-out does not clear IndexedDB.
- PRD 01 lists "Phone or tablet remote control" as a non-goal and says nothing else about phones.

## What this design does

A church's week on a phone is mostly looking things up: what is in Sunday's plan, which arrangement and
key, what a slide will look like on the big screen, whether the video is ready. The rest is small fixes
that today wait until someone is at a computer: a typo found at rehearsal, a song swapped, the photo from
Saturday's event. Planning Center already owns schedules, charts and rehearsal audio (PRD 01
"Non-goals"); what only ordo can show is the slides as the screens will show them, and what only ordo can
change is its own library.

So the phone gets the library and the plans with true previews, and a short list of light edits, each an
operation the editor already has. It runs in the operator app's edit profile with a layout made for one
thumb, under a session the hub caps so that a lost phone can neither drive a service nor delete anything.
Every change is reversible, conflicts with the venue PC and the iPad are merged or re-applied, and the
design protects the **next** service as well as the current one: a phone edit can make the next Go live
fail just as surely as a live command could break the current one, so readiness is checked and shown.

## Decisions

1. **The phone is for the week.** Library viewing and light edits. Beyond the Live now indicator, which
   names the live plan and how many presentations it locks, nothing on a phone reads or writes live state.
2. **Host: the operator app's edit profile on `op.`**, with a compact layout. No new app, hostname, origin
   or DSM rule. The editor store, operations, three-way merge, locks, revisions, thumbnail worker, look
   previews, IndexedDB library copy, search index and resumable uploads exist and run in WebKit
   (design/15 "iPad editing"). A second editor would be a second save path with its own bugs.
3. **Compact layout = not the full profile, and a small viewport**: `profile !== 'full'` and (width under
   700 CSS px or height under 500). It picks components and CSS only. The venue PC can never get it, however
   small its window, and `profileFor` is unchanged.
4. **Phone-first views over the shared stores**: four tabs (Plans, Library, Media, More), list then detail,
   bottom sheets for every dialog. A detail screen replaces the tab bar with its own action bar, so the
   thumb zone never stacks three bars.
5. **No canvas editing on a phone.** The light edits are words, stage notes, hide, duplicate, order,
   arrangement, background or picture swap and template fill: existing pure operations through the same
   editor store, one undo step each.
6. **The hub caps phone sessions.** A phone signs in with `cap: 'light'` whatever PIN matched: the edit
   role minus deletes, fonts, themes, imports, folders, settings, playback fields and every operate and
   live route. A `view` cap refuses every write. Capped sessions are never remembered. Every route
   declares the lowest cap it accepts and new routes refuse capped sessions until they say otherwise.
7. **Presentation edits save on a tap**, create a revision each time and keep the undo stack across saves.
   Drafts are written to the phone as you type.
8. **Plan edits are operations saved at once**, with Undo. On a 409 they are re-applied to the fresh plan
   by item id. Playlists get revisions and History, like presentations.
9. **"For this service" is one playlist write.** A plan item can carry its own section order
   (`sections`), slides hidden in this service (`hiddenSlides`) and a background that overrides every slide
   (`backgroundMediaId`, made a true override). One write, one lock, nothing added to the song.
10. **Song-wide changes say so.** Fixing words, hiding everywhere, duplicating a slide and a background on
    all slides change the song in every plan. The phone names how many plans use it and asks for a second
    tap when there is more than one. Typo fixes are song-wide by intent.
11. **Announcement templates are presentations tagged `template`.** "Add from template" copies a template
    slide into this service's own announcements deck, never into a shared loop without asking.
12. **Live safety stays the hub's**: the 423 lock on the live playlist and its presentations, and the copy
    frozen at goLive. The phone adds no live path. Live now is a small push with the plan's name and lock
    count, never slide text.
13. **Protect the next service.** A readiness check per plan (missing items, media not ready, fonts, text
    that does not fit, changes since the venue PC downloaded for offline use) shows on the phone and in the
    venue PC's playlist editor. Media that is not ready cannot be attached within 12 hours of a plan's
    service time. Uploads stop when the NAS's free space falls below a floor.
14. **Phones never slow a service, by a measured budget.** Capped sockets get a sequence number instead of
    the library delta, Live now is pushed rather than polled, heavy jobs and large uploads wait while live,
    writes have a byte budget, and the rehearsal gate measures the live process with phones in use.
15. **Offline reading with an expiry.** The library copy and a bounded preview cache stay readable for 14
    days after the last signed-in contact. Sign-out, a changed PIN and a revoked pass wipe them. Edits made
    offline are drafts; nothing is sent without a tap; plans are read-only offline.
16. **Previews from the shared rasterizer**, with small preview renditions and fonts loaded by family and
    script. Where WebKit breaks a line differently from the venue PC's Chrome, the preview says so.
17. **Uploads from the camera roll** go into an Inbox, with location data removed from every stored file,
    orientation applied, and the screen kept awake while they run.
18. **Credentials by phase**: PINs with caps (P0 to P2), an optional view PIN for musicians (P1), and
    passkey-backed device passes (P3, ADR 0015), issued from the iPad or the venue PC, never while live.
19. **The venue PC hears about phone edits in its playlist editor**: marks and readiness, never next to Go
    live, never modal, never taking focus.
20. **Languages and right to left from the first phone screen**, and search folds every combining mark.

## 1. Who and why

### 1.1 People

| Person                                 | Credential (phase)                        | On the phone, outside the service                                                                                                                               | Never by accident                                           |
| -------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Maria, worship leader**              | Edit PIN (P0-P2), edit pass (P3)          | Build and reorder Sunday's plan, add a song and pick its order for this service, fix a lyric found at rehearsal, paste a new song, swap a background for Sunday | Change a song in every plan when she meant this Sunday      |
| **Daniel, pastor**                     | Edit PIN, edit pass                       | Check that the sermon deck from his laptop looks right, fix a verse typo, hide a slide he will skip, write stage notes                                          | Lose a typed note; edit the deck during the service         |
| **Sam (keys), Jo (vocals), musicians** | View PIN (P1), view pass (P3)             | This Sunday's order, keys and arrangements, the words by section, any song in the library                                                                       | Change anything; see the pastor's notes                     |
| **Priya, tech volunteer**              | Edit PIN, edit pass                       | Check slides under every look (lobby, stream, stage), see whether a video is ready, fix a typo while preparing                                                  | Touch settings, looks or PINs from a phone                  |
| **The tech lead**                      | Operate PIN on the PC and iPad; edit pass | Everything Priya does; issue and revoke passes from the iPad; read who changed what in History                                                                  | Give a phone the operate role, an output URL or a stage URL |
| **Ben, communications**                | Edit pass, or upload pass (P3)            | Add Saturday's picnic slide from a template with a photo from his camera roll; upload event photos to the Inbox                                                 | Browse or change the rest of the library (upload pass)      |
| **Leila, interpreter**                 | View PIN, view pass                       | Read the week's songs and sermon slides ahead of time, right-to-left paragraphs shown correctly                                                                 | n/a                                                         |
| **The volunteer at the venue PC**      | Operate PIN, venue PC only                | Sees phone changes and readiness in the playlist editor before the service                                                                                      | Be surprised by a change made at 9:55                       |
| **Congregation and visitors**          | none                                      | Not served (audience feed: §11)                                                                                                                                 | n/a                                                         |

### 1.2 The week

| When                      | What happens on phones                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sunday after End service  | Locks lift. A change kept during the service offers itself ("Amazing Grace can be saved now"). Large uploads that waited start. Deferred transcodes run.                            |
| Monday                    | Maria fixes the two typos the band noticed. Each save is a revision.                                                                                                                |
| Tuesday to Thursday       | Maria fills next Sunday's plan: adds songs, picks their order for this service, reorders. Musicians open the plan and rehearse from the words.                                      |
| Friday                    | Daniel uploads the sermon deck from his laptop, checks it on his phone and hides slide 12 for this service. Ben adds the picnic announcement from a template with a photo.          |
| Saturday                  | Priya checks the slides under the stream look. The venue PC downloads the plan for offline use. Readiness says "Ready" or names what to fix.                                        |
| Sunday before the service | Phones can still edit the plan until it goes live. Within 60 minutes of its service time they warn first, and the venue PC's playlist editor marks what changed since its download. |
| During the service        | Phones can read everything. The live plan and its presentations are locked; other plans can still be edited. Transcodes wait and uploads over 25 MB wait.                           |

## 2. Surfaces per phase

### 2.1 Map

| Surface                                            | Route (hash)                         | Who      | Phase |
| -------------------------------------------------- | ------------------------------------ | -------- | ----- |
| Shell: Live now strip, tab bar, sheets, sign-in    | all, `#/login`                       | everyone | P0    |
| Plans (home) and Plan (read, with readiness)       | `#/playlists`, `#/plan/<id>` (new)   | everyone | P1    |
| Library with search and filters                    | `#/library`                          | everyone | P1    |
| Song or deck: words and slide previews             | `#/view/<presentationId>` (new)      | everyone | P1    |
| Slide preview under every look                     | `#/previews/<id>/<slideId>`          | everyone | P1    |
| Media grid                                         | `#/library/media`                    | everyone | P1    |
| More: this phone, offline copy, language, sign out | `#/more` (new)                       | everyone | P1    |
| Words editor (light edits on one presentation)     | `#/edit/<presentationId>` (compact)  | `light`  | P2    |
| Plan editing                                       | `#/playlists/<id>` (compact)         | `light`  | P2    |
| Picture or background, camera roll upload          | sheet in a song, deck or plan        | `light`  | P2    |
| New song from text, add from template              | sheets in Library and Plan           | `light`  | P2    |
| History and conflicts                              | sheets                               | `light`  | P2    |
| Phones (passes) on the iPad and the venue PC       | `#/settings/phones` (regular layout) | operate  | P3    |

### 2.2 The shell (P0)

- **Live now strip**, pinned under the top safe area (`--safe-top`), outside anything that scrolls or
  clips. It shows only while the venue is live or its state is unknown: "Live at the venue: Sunday Service ·
  6 locked", or "Live status unknown: offline". A dot, a word and a colour together. It comes
  from the `venue` push (§3.3), and never carries a cue label or slide text: today's `liveLabel` is the
  first text of the live slide (`packages/domain/src/cues.ts:44-54`) and does not reach a phone. Tapping it
  opens a sheet: "A service is running at the venue. Sunday Service and its 6 presentations are locked until
  it ends. You can still look at everything and change anything else."
- **Freshness line**, under the strip when needed: "Offline · copy from Thu 21:14" or "Can't reach ordo ·
  copy from Thu 21:14".
- **Tab bar**: Plans, Library, Media, More; 56 px plus `--safe-bottom`; labels under icons; no gesture
  needed. Detail screens hide it and show their action bar (Edit, Save, Use this) in its place.
- **Sheets** for every dialog: full width from the bottom, full height under 500 px tall, primary button
  at the bottom, no fixed `min-width`. Focus moves into the sheet and returns on close; the page behind is
  `inert`; Escape and the VoiceOver escape gesture close it.
- **Back** is a button at the top left of a detail screen and also the browser's back (hash routes), so the
  iOS edge swipe works.
- Root fixes: `.app { grid-template-columns: minmax(0, 1fr) }`; no autofocus on a coarse pointer;
  `scrollX` stays 0 after focusing a field.
- **Sign-in**: the PIN keypad as today, no "Remember this device", the request carries `cap` (§3.2), and one
  line under it: "On a phone you can look at everything and make small changes. Services run from the venue
  PC." Locked out (429): "Too many wrong PINs from this network. Try again at 21:40. Everyone on the same
  Wi-Fi may share this wait."

### 2.3 Plans and Plan (P1)

<img src="28-mobile/01-plans-android.png" width="260" alt="Plans home on an Android phone: the next plan with its readiness, then the plans coming up">

- **Plans** lists by `serviceDate` and the new `serviceTime`, in the venue's time zone
  (`settings.general.timeZone`, `apps/hub/src/hub.ts:52-59`), not the phone's: the next plan as a card,
  then the coming ones, then earlier ones folded, then plans without a date under "Other plans". Two
  plans on one date are ordered by time, then name. (Today `nextSunday()` computes in UTC,
  `apps/operator/src/views/playlists/PlaylistsView.tsx:128-132`; P1 fixes it.)
- The card shows the items in one line, **readiness** in words ("Ready", or "1 to check: Offering video is
  still processing"), "Kept offline (8.2 MB)" and when it last changed.
- **Plan** (read): one 64 px row per item with its number, a small first-slide preview, the title and one
  secondary line: for a song its order for this service as short labels ("V1 V2 V3 V4", `arrangementLabel`
  in `lib/arrangement.ts`) and its key; for a deck its kind and slide count; for media its length and
  state ("Processing"); for a timer or an action its label. The readiness block sits at the top and lists
  each finding with the item it belongs to (§5.2). A live plan says "Live at the venue: locked until the
  service ends" and offers no Edit.
- Built from the library copy by a pure `planView(playlist, presentations, media)` and
  `planReadiness(...)` in `packages/domain`, so the phone and the venue PC agree.

### 2.4 Library and search (P1)

<img src="28-mobile/02-library.png" width="260" alt="Library on an iPhone during a service: the Live now strip, filter chips, songs with their keys and orders, locked songs marked, search at the bottom">
<img src="28-mobile/03-search.png" width="260" alt="Search for grace: title matches, lyric matches with the matching line, and a picture, with the search field above the keyboard">

- Filter chips: All, Songs (`kind: song`), Sermons and slides (`slides`), Announcements (`loop`), Templates,
  Archived (the last two off by default). Folders appear as a chip row only when the library uses them.
- Rows of 64 px: a preview, the title, one secondary line (key and order, or kind and slide count).
  Presentations in the live plan carry a lock and the word "Live".
- **Search sits at the bottom**, above the tab bar, where the thumb is; it is never focused on open. Results
  update per keystroke from the core worker's index, which holds titles, full lyrics, CCLI numbers, tags
  and authors (`apps/operator/src/lib/search.ts`). A match in the words shows the matching line with its
  section ("V2: 'Twas grace that taught my heart to fear"). Templates are left out unless their chip is on.
- `normalize` (`search.ts:6-13`) strips only U+0300 to U+036F, then turns every other non-letter into a
  space, so a vocalised Arabic or Hebrew word is split and an unvocalised query misses it. P1 strips
  `\p{Mn}` after NFD, before the punctuation step: one rule for every script, no range lists.
- `[+]` (P2, `light`) opens "New song from text".
- Empty results say what to try: "No songs match 'gracce'. Check the spelling, or search the words."

### 2.5 Song or deck, and slide previews (P1)

<img src="28-mobile/04-song.png" width="260" alt="Amazing Grace opened from Sunday's plan: its order for this service, verse 5 not used, and slide previews in two columns">
<img src="28-mobile/05-slide-looks.png" width="260" alt="One slide under the main look, and below it the lobby lower third, the stream key and the stage screen with the next slide and the stage note">

- **Words** (default for songs): section headings, then each slide's readable text (`readableText`,
  `packages/domain/src/readable.ts`), one block per paragraph with `dir="auto"`, in the order of the plan it
  was opened from (else the first arrangement). Hidden slides are marked, stage notes show under their
  slide. This is the musicians' rehearsal view and costs no rendering.
- **Slides** (default for decks): previews in two columns in portrait, three or four in landscape, labelled
  by section and number with tags in words: "Hidden in this service", "Hidden", "Video", "PowerPoint
  picture", "Doesn't fit" (the editor's overflow check, `textFit.ts`). Previews draw as they scroll into
  view (§3.8).
- Opened from a plan, the header shows that plan's order for this service as chips; tapping a chip scrolls
  to the section.
- **Slide preview**: the main look full width, then the lobby lower third, the stream key on its key colour
  and the stage look with the next slide **in this plan's order** (today `LookPreviews` follows the first
  arrangement, design/15 "Look previews"; the preview job gets the plan's order), and the stage note.
  Previous and Next buttons at the bottom; a horizontal swipe as a shortcut, mirrored in right to left,
  which never takes over a pinch zoom. A video background shows its poster and "Play video (12 MB)".
- A slide set to show its PowerPoint picture (`Slide.pptx.show`) says "This slide shows a picture of the
  PowerPoint slide; text changes would not show on the screens" (design/15 "PowerPoint imports").
- `⋯` holds Add to a plan…, Copy link (a `#/view/<id>` link that works only for signed-in people) and
  Archive (`light`).

### 2.6 Media (P1; upload in P2)

- A three-column grid of preview renditions with filters Pictures, Videos, Backgrounds, From phones and, for
  editors, Inbox. A tile that is not ready says so in words: "Processing", "Waiting for the service to
  end", "Failed: tap for details".
- A tile opens a sheet: name, size, where it is used (`presentationsUsing`, `apps/operator/src/lib/mediaUse.ts:21`),
  "Use as background…" (§2.9) and, for an Inbox item, Approve (removes the `inbox` tag).
- Upload (P2) is the primary button at the bottom (§3.9).

### 2.7 Fixing words: the words editor (P2)

<img src="28-mobile/06-fix-lyric.png" width="260" alt="Words editor for Amazing Grace: verse 2 slide 1 with its lyric corrected, a small preview that fits, and the save bar with undo">

- A view of the same `useEditor` store as the canvas editor (`views/editor/editorStore.ts`): `change(fn)`
  with a pure operation, `undo`, `redo` (200 steps, `editorStore.ts:55`), `save()` with the 409 merge. No
  new save path exists for phones.
- **Text**: one textarea per text box: the lyric box (`Slide.lyricObjectId`) for songs, each unlocked text
  box for decks, labelled by its first words. Typing applies `editText` (`packages/domain/src/textEdit.ts:52`),
  which keeps runs and paragraph styles. Textareas are 16 px or larger (no focus zoom) and `dir="auto"`,
  so adding an Arabic translation line under each English line works as typed. The slide menu has "Split
  here" (at the caret) and "Merge with next".
- **The header says the scope**: "Used in 3 plans. Word changes apply to all of them." Fixing a typo
  everywhere is the point; the line keeps it from being a surprise.
- **Find and replace** in the header `⋯`: the existing `findReplace` (`views/editor/ops/slides.ts:184`),
  matches listed by slide before "Replace all 3".
- **Slide menu**: Hide in this service (when opened from a plan; a playlist write, §3.7), Hide everywhere
  (`hideSlide`, `ops/slides.ts:212`; second tap when the song is in more than one plan), Duplicate
  (`duplicateSlide`, `views/editor/ops.ts:123`; the same rule), Move up, Move down, Background… and Replace
  picture… (§2.9), Notes for the stage screen.
- **Stage notes**: a textarea for `Slide.notes`, with a read-only line saying whether the stage look shows
  notes (`PropsRule.notes`, design/16 "Notes region"); looks are settings and stay off the phone.
- **Fit**: about 150 ms after the last keystroke the slide's small preview redraws in the thumbnail worker,
  and the overflow check marks a box whose text no longer fits: "This line will be cut on the screen.
  Shorten it, or fix the box on a computer."
- **Save bar**: Undo and Redo (typing in one field coalesces into one step, as the editor does), the state
  in words ("Unsaved · 1 change", "Saving…", "Saved · revision 14", "Not saved: no connection. Your change
  is kept on this phone."), and Save. After a save the undo stack stays, so Undo is one more save, as a new
  revision.
- **Drafts** are written to the phone 1 s after each change and on `pagehide` and `visibilitychange`
  (§3.6), because iOS and Android can discard a background tab without any event. Leaving with unsaved
  changes asks "Save / Keep as draft / Discard".
- **Read-only cases**: a slide that is a picture of a PowerPoint slide ("Edit it on a computer"), a deck
  above the presentation size budget (`packages/domain/src/size.ts:24`): "This deck is too large to edit on
  a phone (6.1 MB). Its words can still be read."

### 2.8 Plan editing (P2)

<img src="28-mobile/07-plan-reorder.png" width="260" alt="Plan editing: Be Thou My Vision being dragged up by its grip, move buttons on each row, an Add button at the bottom">

- Reorder with the existing pointer `Sortable` (grip, 300 ms hold, auto-scroll; a cancelled touch puts it
  back; design/15 "Touch") and with move buttons on each row, so VoiceOver, TalkBack and Switch Control
  users reorder without dragging.
- **Add** opens a sheet with library search, songs first, templates left out; choosing a song asks for its
  order for this service (a saved arrangement, or pick sections) and adds it after the selected row.
- **Row menu**: Order for this service…, Hide slides in this service…, Background for this service…
  (§2.9), Remove (with Undo). Transitions and media playback fields stay on a computer.
- **Copy plan for a new date** (in the plan's `⋯`): a new plan with the same items and the next service
  date.
- Every change is one operation saved at once (§3.7), shown in an Undo bar for 10 s and kept in History, so
  the 10 s are never the only chance.
- A live plan is read-only. Within 60 minutes of its service time (§3.12) the first change asks once: "This
  service starts at 10:00. The volunteer may already have checked these slides. Change anyway?"

### 2.9 Picture or background from the library or the camera roll (P2)

<img src="28-mobile/08-photo-background.png" width="260" alt="Background sheet for Amazing Grace: for this service, a photo from the camera roll uploading with location removed, a preview on the main screen covering every slide, Use this waiting for the upload">

- Three scopes, with **This service** as the default: `PlaylistItem.backgroundMediaId`, now a true
  override (§3.5), a playlist write. **This slide** and **All N slides** run `replaceBackground`
  (`ops/slides.ts:361`) with the scope the editor offers, as presentation edits with the "used in N plans"
  line. A picture of another aspect is re-cropped, never stretched.
- **From your photos** opens the native picker (§3.9). The sheet shows the upload, then the preview under
  the main look with the photo in place, and enables **Use this** only when the picture is ready (images
  take seconds). Within 12 hours of the plan's service time, a medium that is not ready cannot be attached
  at all (§5.2).
- **Replace picture** on a slide with one picture (an announcement photo) uses `replacePicture`
  (`ops/pictures.ts`), which keeps the box, mask, flips and crop look.

### 2.10 New song from text, add from template (P2)

- **New song from text**: a large textarea for pasted lyrics (SongSelect's copied text, ChordPro, or plain
  text with `[Verse 1]` labels), parsed by `parseLyrics` (`packages/domain/src/lyrics.ts:161`) and shown as
  sections before saving; title, author, CCLI number, key, theme; then "Add to Sunday Service?". Chord lines
  are kept in `Section.chords` as today and not shown.
- **Add from template**: the template slides (slides of presentations tagged `template`) in a strip; one
  field per text box, labelled by the template's own text ("Title", "Date and place"); "Choose photo" for
  its single picture; a preview under the main look with the fit check per field ("12 characters too long
  for this template").
  - The target defaults to **this service's own announcements deck**: the plan's announcements item when no
    other plan uses it, else a new deck "Announcements · 9 Nov" added to the plan. A shared loop is offered
    second, with "Welcome loop is in 5 plans. Add there for every service?".
  - "Add slide" copies the template slide with `cloneSlide` (fresh ids, `views/editor/ops.ts:100`), applies
    `editText` per field and `replacePicture`, and saves one revision.
  - No templates yet: "Your church has no announcement templates. A designer makes them on a computer: any
    presentation tagged 'template'."

### 2.11 History and conflicts (P2)

- **History** (song, deck or plan): revisions newest first with the time and who saved them ("Thu 21:14 ·
  a phone with the edit PIN", or in P3 "Thu 21:14 · Maria's phone"), what changed (slides changed, items
  moved), and **Restore**, which creates a new revision and loses nothing (`RevisionsDialog`).
  - Restoring a plan revision that names a deleted presentation leaves that item out and says so ("2 items
    were not restored: their presentations were deleted"). An order for this service that names a deleted
    section drops that section.
- **Conflict sheet** (a 409 the three-way merge `mergeThreeWay`, `views/editor/merge.ts:70`, could not
  combine fully): the overlaps by slide, "Keep theirs", "Keep mine" and **Copy my text**, so a typed line is
  never lost even when the person keeps theirs. Cancel has the focus. It is `ConflictDialog`'s content laid
  out for a phone.

### 2.12 States, screen by screen

| State                                  | What the phone shows                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| First sign-in                          | "Getting the library (1.4 MB)…" with progress; Plans fills first. Later starts paint from the IndexedDB copy at once.                               |
| Empty                                  | Plans: "No plans yet. Plans are made on a computer or iPad." Library: "No songs yet." Media: "No pictures yet."                                     |
| Offline                                | "Offline · copy from Thu 21:14". Previews for kept items, words for all. Edits become drafts; plans are read-only.                                  |
| Copy expired (14 days without contact) | "This phone has not reached ordo for 14 days. Sign in to see the library again." The copy stays until sign-in or sign-out.                          |
| Session ended, online                  | The copy stays readable with "Sign in to refresh"; Save opens the sign-in sheet over the editor and continues after it.                             |
| Signed out because a PIN changed       | "The edit PIN was changed, so this phone was signed out and its copy removed. Sign in with the new PIN."                                            |
| Locked out (429)                       | The time left, and that everyone on the same Wi-Fi may share it.                                                                                    |
| Locked during the service              | "Live at the venue: locked until the service ends." Save becomes "Keep my change for after the service" (a draft), offered again after End service. |
| Saved during a goLive                  | When the save landed after goLive fetched the plan: "Saved. The running service uses the version from 9:58." (`apps/hub/src/live.ts:357-370`)       |
| Processing (media)                     | "Processing · usually under a minute" for pictures; "Waiting for the service to end" for videos while live.                                         |
| Upload interrupted                     | "Paused: keep ordo open to finish (3 of 5)". It resumes from the hub's offset when the page is back.                                                |
| Phone storage full                     | "This phone is out of space for ordo. Offline previews are off; your drafts are kept." (`QuotaExceededError` empties the preview cache first.)      |
| NAS disk nearly full                   | Upload refused: "The church's storage is nearly full. Ask the tech lead." (507)                                                                     |
| Too large or picture-only              | Read-only with the reason (§2.7).                                                                                                                   |
| Error                                  | In words with one action: "Could not save: the library is restarting. Try again." (the proxy's 503, design/12 "Routing"); the draft is kept.        |
| Permission                             | A `view` session has no Edit buttons; a refused write says "This phone can look but not change."                                                    |
| App updated                            | The version guard reloads (design/13 "Versioning"); drafts survive in IndexedDB.                                                                    |
| Pass revoked (P3)                      | "This phone was signed out by the church. Its copy of the library was removed."                                                                     |

## 3. Architecture

### 3.1 Where it runs

- **App**: `apps/operator`, edit profile, on `op.<venue>.synology.me`, as on the iPad. The core worker joins
  the hub as an editor (design/15 "The edit profile"): no `LiveCore`, no service cache, no fallback
  authority, every dispatch a no-op.
- **Layout class**: `compact | regular`, `compact` when `profile !== 'full'` and
  `matchMedia('(max-width: 699px), (max-height: 499px)')` matches. It is on `window.__ordo` beside the
  profile for tests. An iPhone in landscape (844x390) stays compact; an iPad in a narrow Split View gets
  the compact views (with its own, uncapped session).
- **Forced profile guard**: `?profile=full` or `ordo.profile` is ignored on a device with neither Window
  Management nor WebHID (it would give a broken operator there). The hub's cap, not this guard, is what
  protects a phone's cookie.
- **Routes**: the existing ones (`#/library`, `#/library/media`, `#/edit/<id>`, `#/playlists[/<id>]`,
  `#/previews/<id>/<slide>`) render compact views on the compact layout; `#/plan/<id>`, `#/view/<id>` and
  `#/more` are new and allowed for every role in `allowedForRole` (`lib/route.ts`). On the compact layout
  settings routes go to the library.
- **Code split**: the canvas editor (`react-konva`, `SlideCanvas.tsx`, the format bar and panels) and the
  settings pages become lazy chunks, so the compact path does not download them (§7).

### 3.2 Sessions, caps and credentials

Every session gets a **cap**, stored on its row in `ordo.db` and checked by both processes:

| Cap     | Who                                                 | Can                                                                                                                          |
| ------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `full`  | Sessions as today: the venue PC, the iPad, a laptop | Its role (operate or edit), unchanged                                                                                        |
| `light` | A phone, whatever PIN matched (edit or operate)     | Read everything an edit session reads; write presentations, playlists, uploads, media names and tags, restores. Nothing else |
| `view`  | The view PIN (P1), a view pass (P3)                 | Read, with deck notes, Inbox media and source documents left out. No writes                                                  |

- **How a phone gets `light`**: the sign-in on an edit-profile device whose shorter **screen** side (from
  `screen.width` and `screen.height`, not the viewport) is under 600 CSS px sends `cap: 'light'`. The
  viewport would leak: Safari's "Request Desktop Website" gives a 980 px layout viewport (verify that
  `screen` stays at the device size there), and unfolded foldables and tablets are wide. An unfolded
  foldable is a tablet and gets what an iPad gets. The cap protects the phone's cookie, not the PIN: anyone
  who knows the operate PIN can still use it at a computer.
- **Refused for `light`**, at the route: every `DELETE`; `/fonts/*`; `/themes/*`; `/import/*` and re-import
  or make-editable; folders; settings writes; PINs and passes; outputs and tokens; backups; media playback
  fields (loop, gain, audio pair); every operate and live route. Every route declares the lowest cap it
  accepts beside its role (design/21 "Authorisation"); the startup check fails a route without one, and the
  default refuses capped sessions, so a new route is closed to phones until it says otherwise.
- **Never remembered**: a capped sign-in ignores and clears the `ordo_device` cookie (today
  `remembered = remember || deviceOk`, `routes.ts:359-366`), so it is a 1-hour sliding session (PRD 09).
- **Role**: a capped session's role is `edit` whatever PIN matched, so everything the hub already refuses
  to the edit role stays refused: `live.event` at the socket (`ws.ts:416`), every operate route, live
  state. The cap only narrows it further.
- **View PIN (P1, optional)**: Settings → PINs gains "View PIN (optional, for musicians)", empty by default
  (off). Its sessions are always `view`. It shares the PIN rate buckets.
- **Revocation before passes**: changing the edit or view PIN ends those sessions (`apps/hub/src/auth.ts:88-97`).
  The hub's 401 then carries `reason: 'pin-changed'`, on which a phone wipes its copy. It also signs out
  the worship leader's iPad; the volunteer guidance says so.
- **Passes (P3, ADR 0015)**: a per-device credential with a label ("Maria's phone"), a preset (`view`,
  `light`, or `upload`: Inbox uploads and its own uploads only) and a lifetime (90 days unused, one year at
  most). No accounts: ADR 0010 holds.
  - Stored in a `passes` table in `ordo.db` (id, label, cap, passkey credential id and public key, created
    by, created, last seen, last network class, expires, revoked). The names `ordo_device` and `devices`
    are taken by the remembered-device cookie and table (`routes.ts:57`, `apps/hub/src/db.ts:51`), which
    stay for the venue PC.
  - **Issued** in Settings → Phones from an operate session on the iPad or the venue PC, refused while a
    service is live. It shows a QR code and an 8-character code for 2 minutes, or makes a single-use invite
    link valid 24 hours. The code is 128 bits in the URL fragment (not in DSM logs or `Referer`).
  - **Claimed** with a **passkey**: the phone registers a WebAuthn platform credential with user
    verification (Face ID, fingerprint or the phone's code) for the pass. Afterwards "Unlock" is one tap and
    a biometric: no PIN typed on the public hostname, a short session, and the passkey is shared between
    Safari and the home-screen app through the phone's keychain (verify on iOS and Android), which removes the
    two-cookie-jars problem. A phone without passkeys gets an `ordo_pass` cookie (`HttpOnly; Secure;
    SameSite=Strict`, host-only) instead. The hub needs a WebAuthn verifier: a new dependency under
    design/21 "Dependencies".
  - **Claim limits**: 10 failures per IP per 15 minutes. No hub-wide claim bucket: 128-bit codes cannot be
    guessed, and a hub-wide bucket would let anyone block real claims.
  - **Revoked** from Settings → Phones ("Revoke", "Revoke all phones"): its sockets close at once (as
    `disconnectOutput` does), its next request gets `401 revoked`, and the phone wipes its copy. Passes
    survive PIN changes.
  - Pass writes record the label in `updatedBy` and in revisions; creation, claim and revocation are logged
    with the label and network class, never a code.

### 3.3 Protocol: what reaches a phone

A capped socket receives `welcome`, `venue`, `library.poke` and `bye`; it may send `hello` and
`time.ping`. It never receives live state, `library.delta`, tokens or settings with tokens.

```ts
// packages/protocol, hub → editor sockets (Zod schemas, design/24)
type Venue = {
  t: 'venue';
  v: 1;
  mode: 'idle' | 'live';
  playlistId?: Id;
  playlistName?: string;
  since?: string; // no cue, no slide text
  lockedPresentationIds: Id[];
};
type LibraryPoke = { t: 'library.poke'; v: 1; seq: number }; // capped sockets, instead of library.delta
```

- `venue` is sent after `welcome` and on goLive, End service and lock changes, built once and written to
  every editor socket. It replaces the 8 s `/live/summary` poll on phones; the poll remains only while the
  socket is down and the page is visible. The iPad's chip keeps using `/live/summary` as design/15 says.
- `library.poke` carries only the library sequence. The phone's core then fetches
  `GET /library/snapshot?since=<seq>` (`routes.ts:420-430`), debounced 2 s and only while visible. That
  request is answered by the library process (redacted for `view`) and only streamed through the live
  process, so a 4 MiB deck saved during a service costs the live process one small string per phone
  instead of 4 MiB per phone.
- Both are new message types: one `APP_VERSION` bump in P1 (design/13 "Versioning").

### 3.4 Hub changes per phase

| Phase | Change                                                                                                                                                    | Process | Why                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| P0    | Session `cap` (`full`, `light`, `view`); `POST /auth/pin { pin, cap }`; every route declares its lowest cap; capped sign-ins clear the device cookie      | both    | §3.2: a phone cookie can neither drive a service nor delete                                                                   |
| P0    | `Origin` check and an `X-Ordo` header on every non-GET API request                                                                                        | both    | Writes rely on `SameSite=Lax` alone today; the hub checks `Origin` only on socket upgrades (`ws.ts:168-183`)                  |
| P0    | Private (LAN) addresses leave the global PIN bucket (50 per 15 minutes, `auth.ts`); the per-IP bucket stays                                               | both    | A scanner on the public name must not lock out the venue PC                                                                   |
| P0    | `DELETE /fonts/:id` answers 423 for fonts the live copy uses, like `DELETE /media/:id` (`routes.ts:656-659`)                                              | library | Today a font can be removed under a running service (`routes.ts:768-771`)                                                     |
| P0    | `affectsContext` (`apps/hub/src/librarylink.ts:66-67`) counts a media change only for the logo and the looks' holding images                              | live    | Today every media change, when no logo is set, makes every output refetch its config (`apps/output/src/link-core.ts:497-515`) |
| P0    | While live: heavy jobs (video, GIF) wait until End service plus 2 minutes; light jobs run under `nice 19` with one thread                                 | library | Today uploads and ffmpeg run at full priority during a service                                                                |
| P0    | `broadcastLibrary` builds the `stripped` string only when a batch has a settings change                                                                   | live    | It stringifies every delta twice (`ws.ts:528-539`)                                                                            |
| P1    | `venue` and `library.poke` (§3.3); at most 80 capped sockets in total                                                                                     | live    | No per-phone serialisation, no per-phone polling                                                                              |
| P1    | `view` cap and the optional view PIN; `view` redaction in snapshots and `?since=`: no `Slide.notes` on decks and loops, no Inbox media                    | library | Musicians read without the edit PIN                                                                                           |
| P1    | `GET /files/:hash` for `view` principals limited to delivery files, preview renditions, posters and fonts                                                 | both    | Today any principal can fetch any hash (`routes.ts:910`), including a stored `.pptx` with its speaker notes                   |
| P1    | `Media.preview` renditions and their backfill, which runs only while no service is live                                                                   | library | §3.8                                                                                                                          |
| P1    | gzip (level 6) for JSON answers over 32 KB, cached per library sequence in the library process                                                            | library | The snapshot shrinks five to ten times; gzip rather than Brotli to spare the NAS CPU                                          |
| P1    | `Playlist.serviceTime`; dates in the venue's time zone                                                                                                    | domain  | §2.3, §5.2                                                                                                                    |
| P1    | Public `GET /health` answers `{ ok, version }`; mode and sequence for authenticated callers only (check its consumers first)                              | live    | Today it tells anyone whether a service is running (`routes.ts:324-331`)                                                      |
| P2    | Playlist revisions: `playlist_revisions`, `GET /playlists/:id/revisions[/:rev]`, `POST /playlists/:id/restore/:rev` (423 while live)                      | library | Today a playlist has a `rev` and a 409 but no history                                                                         |
| P2    | Revision retention for both kinds: newest 50 or 30 days, whichever is more, but at most 200 revisions and 64 MiB per presentation or plan                 | library | Today's prune has no cap (`apps/hub/src/library.ts:392-400`), and phone saves add revisions                                   |
| P2    | `updatedBy` on presentations and playlists; the per-service item fields; the background override (§3.5)                                                   | domain  | §3.5                                                                                                                          |
| P2    | Write budget per session: 60 writes a minute (burst 20) and, while live, 8 MiB of request bodies a minute; uploads: 50 files and 4 GiB a day              | library | A stolen session cannot flood the NAS or the live process                                                                     |
| P2    | Request bodies may be `Content-Encoding: gzip` (decompressed size capped at the presentation budget)                                                      | library | A save sends the whole presentation, up to 4 MiB (`routes.ts:443-453`)                                                        |
| P2    | Image ingest removes location and device metadata from the stored original and the delivery file, applies orientation before reading dimensions; backfill | library | Images up to 3840 px are served as uploaded (`apps/hub/src/media/service.ts:370-385`), GPS included                           |
| P2    | Free-space floor: uploads and backfills stop when the data volume has less than max(5 GiB, 5 %) free (`fs.statfs`), with 507 and a health line            | library | No free-space check exists; the same volume holds `live.db`, `ordo.db` and the backups                                        |
| P2    | Job priority for media the next plan uses; the `inbox` tag on uploads from capped sessions                                                                | library | §5.2, §4                                                                                                                      |
| P3    | Passes: table, principal, `/passes` routes, WebAuthn registration and assertion, claim limits, 3 sockets per pass, revocation closes sockets              | both    | §3.2; ADR 0015                                                                                                                |

### 3.5 Domain changes

| Change                                                                           | Where                                | Meaning                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlaylistItem.sections?: Id[]` (at most 500)                                     | `schemas.ts:727-747`, `cues.ts`      | The section order for this service. When set it wins over `arrangementId`; ids the presentation no longer has are skipped. One playlist write instead of a new presentation arrangement plus a playlist write, which are not atomic and pile up                                                                                                     |
| `PlaylistItem.hiddenSlides?: Id[]`                                               | same                                 | Slides hidden in this service. Their cues are marked `hidden`, exactly as `Slide.hidden` is: sequential navigation skips them, a click on one still shows it (design/27 §9)                                                                                                                                                                         |
| `PlaylistItem.backgroundMediaId` becomes a true override                         | `cues.ts:63`                         | Today a slide's own background wins (`slideBackground(slide) ?? item.backgroundMediaId ?? p.backgroundMediaId`), so for ProPresenter imports, which set one per slide (`packages/importers/src/pro7.ts:730`), the venue PC's "Background override" (`ItemSettings.tsx:104-110`) does nothing. The order becomes item, then slide, then presentation |
| `updatedBy?: { kind: 'operate' \| 'edit' \| 'light' \| 'pass'; label?: string }` | `Presentation`, `Playlist`           | Who made the last change, for the venue PC's marks. Today `savedBy` is `role@ip` in the revisions table only (`library.ts:372-415`), and playlists record nothing                                                                                                                                                                                   |
| `Playlist.serviceTime?: string` (`HH:MM`)                                        | `Playlist`                           | With `serviceDate`, in the venue's time zone: ordering, readiness windows, the warning                                                                                                                                                                                                                                                              |
| `Media.preview?: { hash, width, height }`                                        | `Media`                              | A JPEG at most 640 px wide (PNG with alpha) for drawings under 960 px                                                                                                                                                                                                                                                                               |
| `template` and `inbox` tags                                                      | `Presentation.meta.tags`, media tags | Conventions, no schema change                                                                                                                                                                                                                                                                                                                       |
| `planView`, `planReadiness`, `applyPlaylistOps`                                  | `packages/domain`                    | Pure functions shared by the phone and the venue PC                                                                                                                                                                                                                                                                                                 |

All fields are optional and additive (design/27 §3.2). The cue changes go with renderer and cue goldens and
one `APP_VERSION` bump. The override changes how existing plans look at their next Go live where an item
background sits over a song with per-slide backgrounds; before the first service there are few such plans,
and the venue PC's playlist editor marks them once ("Background for this service now covers every slide").
Since PR #23 a slide's backdrop (the colour or gradient it was imported on, `origin.role: 'bg'`, a
ProPresenter slide's or presentation's colour and a PowerPoint slide's fill) no longer hides an override
that reaches it (`Cue.backgroundOverride`, design/11); the order is still slide first, and the
`pro7.ts:730` reference above is now `slideFromCue`.

### 3.6 Presentation edits and drafts

- Edits go through `useEditor` (§2.7). A save sends the whole presentation, gzip-compressed with
  `CompressionStream` when larger than 32 KB.
- **Drafts** live in an IndexedDB `drafts` store: `{ presentationId, baseRev, draft, savedAt }`, written 1 s
  after each change and on `pagehide` and `visibilitychange` to hidden. At most 20 drafts of up to 4 MiB;
  after 30 days a draft is offered once more, then dropped. Opening the presentation again offers the draft
  ("You have an unsaved change from Thu 21:14").
- A save whose answer was lost and is tapped again gets a 409 whose "theirs" is the phone's own save; the
  three-way merge then has nothing to combine and nothing to save.
- A 423 keeps the change as a draft marked "after the service"; when the `venue` push says idle, the phone
  offers it, merged with any newer version.

### 3.7 Playlist operations and rebase

```ts
type PlaylistOp =
  | { k: 'move'; itemId: Id; after: Id | null } // null = to the top
  | { k: 'add'; item: PlaylistItem; after: Id | null } // item.id made on the phone
  | { k: 'remove'; itemId: Id }
  | { k: 'arrangement'; itemId: Id; arrangementId?: Id; sections?: Id[] }
  | { k: 'hide'; itemId: Id; hiddenSlides: Id[] }
  | { k: 'background'; itemId: Id; mediaId?: Id };
```

- Each operation is applied to the phone's copy at once and saved with `PUT /playlists/:id` and the `rev` it
  was made on.
- **On 409** the phone fetches the plan, re-applies its unsaved operations in order by item id, and saves
  again, at most twice before it shows the conflict. A `move` after an item that is gone goes to the end,
  with a note; an operation on an item that is gone is dropped with a note ("Amazing Grace was removed on
  another device; your order change was not kept").
- **Idempotent by item id**: an `add` whose item id exists is skipped, so a save whose answer was lost never
  adds the song twice.
- **On 423** (the plan went live) nothing is saved; the phone lists what was not saved and offers "Apply
  again after the service" from History.
- `applyPlaylistOps` is pure, with property tests (re-applying is idempotent, item ids stay unique). The
  regular layout's `PlaylistEditor` uses it too, so the iPad and the venue PC stop dropping a change on a
  409 (`views/playlists/PlaylistEditor.tsx:69-84` today says "Reloaded the latest version; redo your last
  change").

### 3.8 Previews as they will look

- **Drawing**: the thumbnail worker draws each slide with the shared rasterizer under a look, as the
  Previews page does (`apps/operator/src/workers/thumb.worker.ts`, design/15 "Look previews"). Tiles draw
  at their CSS width × min(devicePixelRatio, 2); a drawn tile is cached as a blob keyed by the slide, the
  look, the renditions it uses and the font generation, so scrolling back is instant and a change redraws
  only what changed.
- **Preview renditions**: every image gets `Media.preview`, made by the delivery downscale
  (`downscaleImage`, `media/service.ts:370-383`) as a light job; videos use their 640x360 poster
  (`media/ffmpeg.ts:237`). Imported page pictures are media and get one too. A 3840 px background of 1 to
  3 MB becomes about 60 KB. The worker uses `preview` under 960 px and the delivery file above.
- **Fonts**: on the compact layout `syncFonts` (`services/fonts.ts:21-44`, which today loads every library
  font) registers every face but loads one only when a slide on screen uses its family
  (`referencedFontFamilies`, `packages/domain/src/resolve.ts:153`) or needs it for its script
  (`textScripts`, `readable.ts:75`: Arabic, Hebrew, Devanagari and CJK faces by script, not only by family).
  A preview drawn before its font arrived is redrawn when the resolver's generation changes (design/27 §10).
- **Honesty**: a preview drawn without a font it needs, or without its rendition yet, says "Preview may
  differ: Montserrat not loaded yet".
- **WebKit text**: the text engine measures with canvas `measureText`, probed in Chromium
  (`packages/renderer/src/text/measure.ts:4-20`). WebKit may measure, space letters or apply `lang`
  differently, so an iPhone could break a line where the venue PC does not. P1 adds a test that compares
  the line-break positions of every paragraph in WebKit and Chromium over the fixture library (and, at the
  gate, the church's library). Where they differ, previews on WebKit carry "Line breaks on this phone may
  differ from the screens", and the fix is to measure from the font's own advance widths (the sfnt reader
  in `packages/pptx-scene/src/metrics.ts` that table layout uses; verify it covers shaping well enough).
  The claim "as they will look" is made only where the test holds.

### 3.9 Uploads from the camera roll

- The picker is `<input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime">`,
  so iOS hands over JPEG; a HEIC that slips through is refused with "This photo is HEIC. Choose 'Most
  compatible' in the camera settings, or share it as JPEG." (the sniffer refuses HEIC, `media/store.ts:76`).
- Uploads use the resumable route (`POST /media/uploads`, `PATCH` with `Upload-Offset`,
  `routes.ts:673-750`) in 4 MB chunks, one file at a time, resuming from `GET /media/uploads/:id` after a
  dropped connection or a suspended page. While an upload runs the phone holds a Screen Wake Lock (Safari
  16.4 and later; in home-screen apps verify the iOS version) and says "Keep ordo open until this finishes";
  iOS has no background upload for web apps.
- Uploads from capped sessions are tagged `from-phone` and `inbox` (and in P3 the pass label). An Inbox
  item is usable at once by editors (choosing it in an edit approves it) and hidden from `view` principals
  until approved.
- **While a service is live** (from the `venue` push): files up to 25 MB go ahead; larger ones wait with
  "Waiting: a service is running at the venue" and start after End service.
- **Privacy**: the hub removes location and device fields from the stored original and the delivery file,
  keeping only orientation, which it applies before reading the size, so a portrait iPhone photo is upright
  and its width and height are right for `replaceBackground`.
- **iPhone HDR video**: tone mapping to BT.709 is a hub follow-up; until then the sheet says "May look
  washed out on the screens".
- **Android "Share to ordo"** (P2, Chrome only): a `share_target` in the manifest posts shared photos to the
  service worker, which keeps them in IndexedDB and opens the upload sheet. iOS does not support share
  targets for web apps.

### 3.10 Offline copy, cache and expiry

| Store                            | Contents                                                        | Bound                                                                           | Lifetime                                                       |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| IndexedDB library copy (exists)  | Snapshot, changes, search index                                 | The library (budgets in design/27 §3.4)                                         | Readable 14 days after the last signed-in contact; wiped below |
| IndexedDB `drafts` (new)         | Unsaved presentation drafts and pending plan operations         | 20 drafts, 4 MiB each                                                           | Until saved or discarded; 30 days                              |
| Cache Storage `ordo-phone` (new) | Preview renditions, posters, fonts used, drawn tiles            | 150 MB or 10 % of `navigator.storage.estimate().quota`, least recently used out | Until sign-out or eviction                                     |
| `localStorage`                   | Words or Slides, filters, language, last signed-in contact time | small                                                                           | as today                                                       |

- **Keep offline**: the next plan's previews, backgrounds and fonts (about 5 to 10 MB for six songs, a
  sermon deck, ten backgrounds and three font families). The first time, the phone shows the size and asks
  ("Keep Sunday Service offline? 8.2 MB"); afterwards it follows the choice made in More (Automatically, Ask
  each time, Off). It never downloads while a service is live or while the page is hidden. iOS does not
  tell a web page whether it is on Wi-Fi, so the person chooses.
- **Expiry and wipe**: the copy is readable without a PIN for 14 days after the last signed-in contact;
  then it asks for sign-in before showing anything. Sign-out (after asking about drafts), `401
  pin-changed` and `401 revoked` wipe the library copy, drafts and `ordo-phone`. This is the trade-off made
  explicit: a phone in airplane mode shows what it last saw for up to 14 days; after that, or after the
  church changes the PIN, it shows nothing.
- `navigator.storage.persist()` is asked once after sign-in, as on the iPad. Safari may drop
  script-written storage after 7 days without use outside an installed web app; the copy then reloads from
  the hub.
- A `QuotaExceededError` empties `ordo-phone` first, then turns Keep offline off with a line saying so;
  drafts are never evicted by ordo.

### 3.11 Installable web app and the phone lifecycle

- The manifest, icons and safe-area variables exist (design/15 "Installable web app and lifecycle"). On
  current iOS, Add to Home Screen opens ordo as a web app with its own cookies and storage: a second
  sign-in and a second copy. The sign-in sheet says so in Safari ("Using ordo from your home screen? Sign in
  there; it keeps its own copy"), and P3 passkeys make the second sign-in one tap.
- **Bottom bars and the keyboard**: the viewport meta adds `interactive-widget=resizes-content` (Android
  Chrome); the bottom search field and the save bar follow `visualViewport` so they sit above the keyboard
  in Safari, where a `position: fixed` element stays in the layout viewport. Safari's own bottom address
  bar is the reason detail screens hide the tab bar (§2.2); check the floating bar of the current iOS
  design on a device.
- On `pageshow` (including `persisted`, the restore iOS often uses), `visibilitychange` to visible and
  `online`: the core reconnects and catches up with `?since=`, Live now refreshes, nothing that did not
  change is redrawn. Android may freeze or discard hidden pages; drafts in IndexedDB survive that.
- **No write is resent by itself** except upload chunks, which the hub checks against `Upload-Offset`.
- Nothing polls while the page is hidden.

### 3.12 The venue PC side (P2)

Each item lands on a weekday with its own test, and none touches Go live:

- **Marks in the playlist editor** only: items whose presentation, or the plan itself, changed in the last 24
  hours from a capped session or a pass ("Lyrics changed Thu 21:14 · a phone", P3 "· Maria's phone"), from
  `updatedBy` and `updatedAt`. Non-modal, never taking focus (design/15 "Session expiry": a focused field
  would take the GO key), never beside Go live, never blocking it.
- **Readiness** in the playlist editor, from the same `planReadiness` as the phone, plus one input only the
  PC has: "New since this PC downloaded for offline use: download again", from comparing the plan's files
  with its cache (design/17 "Preparing").
- `PlaylistEditor` applies plan changes as operations with rebase (§3.7) instead of dropping them on a 409.
- "New for this service" (`ItemSettings.tsx:50-62`) writes the item's `sections` instead of creating a
  presentation arrangement; "Background override" becomes "Background for this service" and covers every
  slide (§3.5).
- **The warning window** (§2.8) uses `serviceDate` and `serviceTime` in the venue's time zone. Whether the
  last hour warns or blocks is the church's choice (§12).

## 4. Security on the public hostname

`op.` is public so people can prepare from home (PRD 09). Phones bring more PIN typing on that hostname,
lost and shared phones, links forwarded in group chats and personal photos.

| Threat                                             | Control                                                                                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A scanner guesses PINs and trips the global bucket | LAN addresses leave the global bucket (P0); per-IP 5 per 15 minutes stays. Passes (P3) remove PIN typing on phones.                                                                                                |
| A lost or stolen phone drives the service          | `light` sessions are refused every live and operate route and `live.event` (§3.2).                                                                                                                                 |
| A lost phone deletes a song and its revisions      | `light` refuses every `DELETE` (today `DELETE /presentations/:id` also removes all revisions, `routes.ts:455-462`), fonts, themes, imports and folders.                                                            |
| A lost phone shows the library offline             | 14-day expiry after the last signed-in contact; wiped on sign-out, `pin-changed` and `revoked` (§3.10). Change the edit PIN to cut off every phone (P0 to P2); revoke one pass (P3).                               |
| A phone holds an output or stage URL               | Never given: edit sessions receive no tokens (`ws.ts:528-539`). Opening the stage URL on a phone would also supersede and close the venue's stage screen (`ws.ts:386-394`); the volunteer guidance says so.        |
| CSRF on writes                                     | `Origin` check and an `X-Ordo` header on every non-GET request (P0); cookies stay host-only. The risk is low (`synology.me` is a public suffix) but the docs must match the code.                                  |
| A shared invite link (P3)                          | Single use, 24 hours, 128 bits in the fragment, shown as "claimed by a phone over the internet at 21:14", revocable at once. Issued only from the iPad or the venue PC, never while live.                          |
| Script injection through slide text or names       | Text rendered with `textContent`; the apps' strict CSP; API responses (files too) are sandboxed documents, an SVG a download (design/21).                                                                          |
| A stolen session floods the NAS                    | Write and upload budgets per session or pass; the free-space floor; uploads over 25 MB wait while live.                                                                                                            |
| Location and faces in photos                       | Location removed from every stored file, with a backfill (P2). Phone uploads land in the Inbox, hidden from `view` until approved. Consent for photos of people, children above all, is the church's policy (§12). |
| Pastoral notes on many phones                      | `view` gets songs and plans in full and decks without `Slide.notes`; `/files/:hash` refuses source documents to `view` (§3.4).                                                                                     |
| Everyone at church behind one address              | Without split DNS, phones on church Wi-Fi reach the public name through the router and share one per-IP bucket: five wrong PINs lock the building out for 15 minutes. Split DNS is an install item (§5.4).         |
| `GET /health` tells anyone when a service runs     | Public answer reduced to `{ ok, version }` (P1).                                                                                                                                                                   |
| A phishing page that looks like ordo               | Invites never ask for a PIN; the sign-in page shows the venue's name and hostname; volunteers are told "ordo never asks for a PIN in a link".                                                                      |

Doc corrections that come with P0, citing the code: cookies are host-only (no `Domain`, `routes.ts:347-353`),
which is safer and stays; HTTP writes had no `Origin` check before P0; the stage window authenticates with a
token principal.

## 5. Reliability and degraded modes

### 5.1 The live boundary

- The live playlist and its presentations answer 423 to every write (`routes.ts:368-375`, `:444-478`,
  `:530-546`); the phone shows the lock first, from the `venue` push.
- Even an unlocked write cannot reach a running service: goLive freezes a copy (`resolved`,
  `packages/domain/src/live.ts:24-56`, design/13 "Live events"). A save that lands during goLive says which
  version the service uses (§2.12).
- What does reach the outputs mid-service is their **config**: settings, fonts and the logo (design/12 "Data
  between them"). Phones cannot write settings, fonts or themes (`light`), fonts the live copy uses are
  locked (P0), and media changes no longer refresh the outputs' config unless they touch the logo or a
  holding image (P0).

### 5.2 Protecting the next service

A phone can break a Sunday without touching live state by making the next Go live fail or the venue PC's
offline copy incomplete. goLive refuses missing presentations and media that is still processing or
failed (`packages/domain/src/goLive.ts:209-216`).

- **Readiness** (`planReadiness`, from the library copy, no hub call), shown on the phone's Plan and in the
  venue PC's playlist editor:

  | Finding                                     | Level         | Example                                                           |
  | ------------------------------------------- | ------------- | ----------------------------------------------------------------- |
  | A presentation or medium is missing         | Go live fails | "Item 4: the presentation was deleted"                            |
  | Media processing or failed                  | Go live fails | "Offering video is still processing"                              |
  | A video waiting for End service             | Go live fails | "Uploaded during the 9:00 service; it is processed after it ends" |
  | A font is missing                           | Check         | "Montserrat is used on 6 slides and is not in the library"        |
  | Text does not fit                           | Check         | "Sermon, slide 14: the last line will be cut"                     |
  | PowerPoint pictures still drawing           | Check         | "Sermon: 3 slides are still being drawn"                          |
  | Hidden slides                               | Note          | "Amazing Grace: 1 slide hidden in this service"                   |
  | Changed from a phone in the last 24 hours   | Note          | "Lyrics changed Thu 21:14 · a phone"                              |
  | New since the PC downloaded for offline use | Check (PC)    | "2 new pictures: download again"                                  |

- **Rules near the service**: within 12 hours of a plan's service time, a phone attaches only media that is
  ready; outside that window it can attach a processing medium, and readiness shows it until it is ready.
  The hub runs jobs for media the next plan uses first, and between two services on one morning.
- **Disk**: uploads and backfills stop above the free-space floor (§3.4); the venue PC's health shows "NAS
  storage nearly full".

### 5.3 Load on the live process

The live process is the front door (design/12 "Routing"). For each phone it handles: the built app and
fonts (it serves every font and the live playlist's media itself), the socket, `venue` and `library.poke`
messages, `/auth/me`, and the proxying of every other request and upload body, including the hold of each
write's answer until the change is applied (up to 2.5 s, design/12 "Read your writes"). Its heartbeat must
reach the supervisor every 500 ms and it is restarted after 5 s of silence.

So phones are not free, and the budget is measured, not assumed:

- No per-phone serialisation: capped sockets get `library.poke` and fetch changes from the library process.
- No per-phone polling: Live now is pushed.
- While live: no Keep offline downloads, uploads over 25 MB wait, 8 MiB of request bodies a minute per
  session, heavy jobs wait, light jobs are niced.
- At most 80 capped sockets (3 per pass in P3).
- **The gate**: during a rehearsal service with 20 phones signed in, browsing and two of them uploading
  photos and saving decks: zero missed vsync on every output, live-process event-loop lag p99 within 5 ms of
  a run without phones, and no late supervisor heartbeat.

### 5.4 Degraded behaviour

| Situation                                 | Reading                               | Editing                                                                             | Service                     |
| ----------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| Online                                    | Fresh                                 | Normal                                                                              | Unaffected                  |
| Slow or flaky connection                  | The copy at once, refreshed behind    | "Saving…", then the result; uploads resume by themselves                            | Unaffected                  |
| Offline                                   | The copy with its time; kept previews | Drafts only; plans read-only                                                        | Unaffected                  |
| Library process restarting (503)          | The copy                              | "The library is restarting. Try again", draft kept                                  | Unaffected (design/12)      |
| Hub or NAS down                           | The copy                              | As offline                                                                          | Continues (design/17)       |
| A service is live                         | Everything; Live now strip            | Live plan and its presentations locked; others editable; large uploads wait         | Unaffected (§5.3, measured) |
| The plan goes live while a phone edits it | The copy                              | Pending operations listed as not saved, kept for after the service                  | Unaffected                  |
| Session ended                             | The copy, "Sign in to refresh"        | Sign-in sheet, then the save continues                                              | n/a                         |
| Storage evicted (Safari, 7 days)          | Reload from the hub                   | Drafts lost only if evicted with it; the installed app and `persist()` make it rare | n/a                         |
| At church, internet down                  | The copy (see split DNS below)        | As offline                                                                          | Unaffected                  |
| App version changed                       | Reload on `bye version`               | Drafts survive                                                                      | n/a                         |

**Split DNS is an install item.** Fixing a typo found at rehearsal is a core use, but without hairpin NAT a
phone on church Wi-Fi cannot reach the public hostname at all, and with it every phone shares the router's
address in the PIN buckets. design/22 gains a step beside the PC's hosts file (step 3): the DSM DNS Server
or the router answers `op.<venue>.synology.me` with the NAS's LAN address on church Wi-Fi. The fallback, said
in the volunteer guidance, is "use mobile data". Tested at the venue at the P1 gate.

### 5.5 Conflicts with the venue PC and the iPad

| Collision                                              | Outcome                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Phone and iPad change different slides of one song     | 409; the three-way merge combines both: "Combined with a change saved at 21:10"     |
| Both change the same line                              | Conflict sheet: Keep theirs, Keep mine, Copy my text                                |
| Phone saves a song the PC just put live                | 423; the draft is kept and offered after End service, merged with any newer version |
| Phone saved just as the PC went live                   | Saved; the phone says which version the service uses (§2.12)                        |
| Phone reorders a plan while the PC edits the same plan | 409; the phone's operations are re-applied by item id (§3.7)                        |
| A draft made offline on Tuesday is saved on Friday     | 409 against Tuesday's base, merged as above; never sent without a tap               |
| The song was deleted elsewhere                         | 404: "This song was deleted on another device. Save your text as a new song?"       |
| A PowerPoint follow-up job saved the deck meanwhile    | Taken over as the editor does today (`adoptJobSaves`)                               |
| Two phones add the same song                           | Two items (both people meant it); each has its own Undo                             |
| A phone change at 9:55 before a 10:00 service          | The warning first (§2.8); the venue PC marks it and readiness lists it              |

Presence ("Maria is editing Amazing Grace") would prevent some of these, but it means a fan-out on the live
process for every open editor. It is left for after P2's measurements (§11).

## 6. Accessibility and languages

- **One hand**: primary actions (Save, Add, Upload, Use this, Done) in the bottom third; search at the
  bottom; sheets from the bottom; nothing essential in the home-indicator band or within 16 px of the side
  edges (the back swipe).
- **Targets and type**: 44 px targets and 16 px inputs (design/15 "Touch"); text in `rem`, with
  `font: -apple-system-body` on the root in WebKit so iOS Dynamic Type applies, and Android's font scale
  through `rem`. Layouts reflow at 320 CSS px and at 200 % text (WCAG 1.4.10, 1.4.4); list rows grow rather
  than cut the second line. The words editor at 200 % has its own screenshot test.
- **Glanceable**: titles first, one secondary line, every status a word plus an icon ("Locked", "Hidden",
  "Processing"), never colour alone.
- **Screen readers**: headings per screen and section; a list row is one control named "Amazing Grace, song,
  key G, verses 1 to 4"; a slide preview is named from its text ("Slide 3 of 8, verse 2: 'Twas grace that
  taught my heart…"); the save state is a polite live region; reorder by the move buttons; the Undo bar is
  reachable and History keeps the change (WCAG 2.2.1).
- **Voice Control**: accessible names match the visible labels ("Save", not "Save presentation").
- **Sheets**: focus moves in and back, the page behind is `inert`, the escape gesture closes them.
- **Zoom**: pinch zoom stays on (design/15) and works on the slide preview; the swipe never takes it over.
- **Contrast and motion**: WCAG 2.2 AA in the operator's dark colours (`--fg3` is checked at 4.5:1 by
  `apps/operator/test/styles.test.ts`); `prefers-contrast`, `forced-colors` and `prefers-reduced-motion`
  (no sheet slides, no swipe animation) respected.
- **Content direction**: every paragraph of slide text, notes and titles is its own block with
  `dir="auto"` and `unicode-bidi: plaintext`, using the stage's paragraph code (design/16 "Direction") moved
  to a shared module; `TextObject.lang` becomes `lang` where known. Textareas are `dir="auto"`.
- **UI language**: the new compact views take their strings from a catalog (English first; ICU plurals;
  the church names the next languages, §12), chosen from `navigator.languages` with an override in More;
  `<html lang dir>` follows it; CSS logical properties so the compact UI mirrors in a right-to-left
  language, including the Previous and Next buttons, the swipe and the chevrons; dates through
  `Intl.DateTimeFormat`. **Known gap**: the regular layout (iPad, venue PC) stays English with inline
  strings, so a volunteer who reads the phone in Arabic sees English on the iPad. The catalog is where
  that can start.
- **Search** folds every combining mark (§2.4): "الله" finds "اللّٰه".

## 7. Performance budgets

| Budget                                     | Target                                                                                                                  | Measured by                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| First load, cold, 4G                       | Compact path ≤ 300 KB gzip (today about 580 KB; canvas editor and settings lazy); interactive ≤ 3 s                     | Playwright phone projects with throttling   |
| Warm start (installed, cached)             | Plans painted from IndexedDB ≤ 1 s                                                                                      | Same                                        |
| First sync of a typical library            | ≤ 10 MB transferred (gzip snapshot)                                                                                     | At the venue with the church's library      |
| Search                                     | ≤ 100 ms per keystroke for 2,000 presentations                                                                          | Unit benchmark of the core index            |
| Previews                                   | First visible row ≤ 1.5 s after opening a song (fonts cached); ≤ 80 ms per tile at 360 px × 2 on a three-year-old phone | Rehearsal device test                       |
| Opening a song online, renditions cached   | ≤ 300 KB                                                                                                                | Network log                                 |
| Save                                       | A song (gzip body ≤ 64 KB): p95 ≤ 2 s on 4G. A larger deck: ≤ 2 s plus 1 s per 500 KB of gzip body                      | Client timing                               |
| Memory                                     | ≤ 300 MB JS heap on an iPhone; at most 400 drawn tiles in memory                                                        | Safari Web Inspector at the gate            |
| Data and battery                           | No polling while hidden; Keep offline only on request or as chosen; tiles at DPR ≤ 2                                    | Network log over a week of normal use       |
| The service while phones browse and upload | Zero missed vsync on every output; live-process lag p99 within 5 ms of a run without phones; no late heartbeat          | Rehearsal gate with output telemetry (§5.3) |

## 8. Testing

Following design/23.

- **Playwright projects** beside the iPad ones (`playwright.config.ts`): `webkit-iphone` (390x844, touch,
  iPhone descriptor) and `chromium-android` (360x800, touch, Pixel descriptor, `?profile=edit` because
  desktop Chromium has Window Management), both on `e2e/phone/*.spec.ts`; and `chromium-tablet` (an
  Android tablet at 800x1280) running the iPad specs, since Android tablets and unfolded foldables get the
  regular layout and it has only been tested in WebKit. Each spec starts its own hub, as the iPad specs do.
- **Layout**: on every compact route `scrollWidth <= innerWidth`, `scrollX === 0` after focusing each
  field, targets at least 44 px, the Live now strip, the tab bar and the save bar inside the visual
  viewport (also with the keyboard open), sheets within 360 px; 844x390 stays compact; the full profile's
  screenshots are unchanged, also in a window under 500 px tall.
- **Flows**: browse Plans; open a plan, a song and a slide preview under every look; search by title, by a
  lyric line, by a CCLI number and by an unvocalised Hebrew word; fix a lyric line, save, undo, save,
  restore from History; add a translation line under each line; hide a slide in this service and
  everywhere; duplicate a slide (the "used in N plans" step); add a song to a plan with an order for this
  service; reorder by the move buttons and by dragging; set a background for this service on a ProPresenter
  song with per-slide backgrounds and see it on every slide; upload a JPEG fixture and use it; add an
  announcement from a template into this service's deck; new song from pasted text.
- **Conflicts**: a second client saves the same song (different slides: merged; same line: the sheet); a
  second client reorders the plan (operations re-applied); a lost save answer (route aborted after the hub
  applied it: no duplicate item, no conflict); a 423 while editing (draft kept, offered after End service);
  a save during goLive (the version message); a deleted song (save as new).
- **Drafts**: the page is closed with no `beforeunload` (Chromium `Page.close`, WebKit context close) one
  second after typing; the draft is offered on reopening.
- **Offline**: with the network blocked the app loads from the shell and IndexedDB, previews show from
  `ordo-phone`, the freshness line shows, edits become drafts, plans are read-only; with the clock moved 15
  days the copy asks for sign-in; a `401 pin-changed` wipes it.
- **Lifecycle**: Chromium `Page.setWebLifecycleState` frozen then active; WebKit `pageshow` with
  `persisted`; the session expiring mid-edit.
- **Live boundary**: a `light` session's `live.event`, `/actions`, `/live/events`, every `DELETE`, fonts,
  themes, imports and settings writes are refused; a forced `?profile=full` on the touch projects stays
  `edit`; a capped sign-in clears the device cookie; a live plan shows no Edit; the Live now strip never
  contains slide text; a media upload while live makes no output refetch its config.
- **Readiness**: each finding of §5.2 from a fixture; attaching a processing video within 12 hours is
  refused; the free-space floor (a small test volume) refuses an upload with 507.
- **Hub**: renditions made and backfilled (never while live); deferred heavy jobs while live; location
  gone from stored originals and delivery files and a portrait photo upright with the right size; playlist
  revisions and restore (423 while live); retention caps; write budgets; `view` redaction in snapshots,
  `?since=` and `/files`; the global bucket ignoring LAN addresses; `Origin` refusals.
- **Text**: line-break positions per paragraph in WebKit and Chromium agree over the fixture library
  (§3.8); the list of disagreements is the gate's evidence.
- **Passes (P3)**: each cap opens only its routes; a claim code works once and not after its time; the
  claim and PIN buckets are independent; a passkey assertion creates a session (WebAuthn virtual
  authenticator in Chromium); revoke closes sockets within 1 s and the phone wipes its copy.
- **Accessibility**: axe on every compact screen; screenshots at 200 % text and with an RTL UI language; a
  manual VoiceOver and TalkBack pass at each gate.
- **Devices**: the gates run on real phones: the two newest major iOS versions and the oldest one the
  volunteers use, and a current Android Chrome (§12).

## 9. Milestones

Nothing here changes the live path of the venue PC before the first service. The hub parts of P0 land after
the first live service (milestones.md "After the first service"), on a weekday, each behind its own test;
every phase ships behind the setting `phones.enabled` (design/24: feature flags are settings), off by
default, which returns today's behaviour. The compact shell alone changes nothing for the full profile
(its screenshot tests say so) and may land earlier. Each gate includes a rehearsal service with phones in use.

| Phase                              | Ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exit criteria                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0. A phone is safe to sign in** | Caps (`light`, `view`) at every route, failing closed; capped sign-ins never remembered; `Origin` and header checks; LAN out of the global bucket; live fonts locked; narrower `affectsContext`; jobs paced while live; one stringify per delta. The compact shell, layout class, sheets, tab bar, sign-in; the phone and tablet Playwright projects                                                                                                                                                                      | Every compact route passes the layout checks in WebKit and Chromium; the full profile's screenshots are unchanged; every refusal test of §8 "Live boundary" passes; a 500 MB video uploaded during a rehearsal service waits for End service, a photo upload makes no output refetch, and the outputs report zero missed vsync                                                                                              |
| **P1. The library in your pocket** | Plans, Plan with readiness, Library with bottom search, Song or deck (Words and Slides), slide preview under every look, Media grid, More; `venue` and `library.poke`; the view cap, view PIN and redaction; renditions and backfill; lazy fonts by family and script; Keep offline, expiry and wipe; gzip; `serviceTime`; search folding; the string catalog and `dir="auto"`; the WebKit line-break test; split DNS in design/22                                                                                        | The worship lead and two tech volunteers find any song in under 10 s, read Sunday's plan in airplane mode, and confirm on five real slides (main, lobby, stream, stage) that previews match the screens, or the line-break note shows where they do not; a musician reads the plan with the view PIN and sees no deck notes; budgets of §7 met at the venue with the church's library; a phone on church Wi-Fi reaches ordo |
| **P2. Light changes**              | Words editor (text, split and merge, find and replace, stage notes, hide, duplicate), drafts, History and restore; Plan editing with operations, rebase, playlist revisions and retention caps; per-service order, hidden slides and background override; camera-roll uploads with Inbox, location removal, Wake Lock and Android share; templates; new song from text; conflict sheet; `updatedBy`; write and upload budgets; the free-space floor; on the venue PC the marks, readiness and `PlaylistEditor` operations | The scripted conflict, lock and readiness scenarios pass end to end; in a usability session the worship lead does every light change of the direction one-handed on her own phone; during a rehearsal service 20 phones browse and two upload and save, with the §5.3 gate met; no 423 bypass in any test                                                                                                                   |
| **P3. Phones for the whole team**  | Passes with passkeys (`view`, `light`, `upload`), QR and invite claims, Settings → Phones on the iPad and the venue PC, labels in History and the marks, socket caps per pass, wipe on revoke; ADR 0015                                                                                                                                                                                                                                                                                                                   | A band of eight reads the plan on view passes for two weeks; revoking a pass closes its sockets within 1 s and wipes the copy on its next contact; the pass tests pass; the external scan (milestones 3.10) is repeated                                                                                                                                                                                                     |

If the church values band access more than phone editing, P3 can come before P2; the view PIN of P1 is the
cheap step until then.

## 10. What a phone must never do

1. Send anything on the live path (`live.event`, `/actions`, `/live/events`, `preview`, `live.adopt`,
   `rtc.signal`), run `LiveCore`, or be forced into the full profile.
2. Hold the operate role, an output or stage token, or an output or stage URL.
3. Change settings, looks, themes, fonts or PINs, or issue passes.
4. Delete presentations, plans, media or fonts.
5. Import PowerPoint, PDF or ProPresenter files.
6. Edit slide layout on a canvas.
7. Send a change the person did not tap, or replay one after a reconnect.
8. Start a heavy job or a large upload while a service is live, or attach media that is not ready within 12
   hours of a plan's service.
9. Show slide text, the next slide or timers of a running service.
10. Ask for a PIN in a link, or keep a library copy after sign-out, a PIN change or revocation.

## 11. Not now

Each item is out of scope by the tech lead's direction. The second column says why; the third what it would
need if the church wants it after the first service.

| Not now                                                             | Why                                                                                                                                                                               | What it would need later                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Live control from a phone** (GO, Next, Back, clears, logo, jumps) | The venue PC is the authority. `next` and `prev` are relative and double-advance on a retry; a hub applying phone commands would break the fallback bus and the hold (design/17). | An ADR for requests relayed to the venue PC's core, which decides them like a Stream Deck press: absolute intents with an expected position, a short expiry, no replay, a visible owner, scoped grants claimed at the PC, a rehearsal gate |
| **A phone remote or clicker**                                       | The same, and the worst stories in other products are remotes fighting the booth and stale presses after a phone wakes                                                            | The same ADR, grants scoped to one item ("this sermon only"), and a guard against the PC's own keys pressing the same intent                                                                                                               |
| **Confidence or stage view on a phone**                             | Live state on phones needs honest freshness, Wake Lock and load caps; reusing the stage token would supersede and close the stage screen (`ws.ts:386-394`)                        | One bounded projection of the live state from a pure function, cached per variant and capped, sent from the live process, and a rehearsal gate with output telemetry                                                                       |
| **Audience lyrics feed**                                            | Lyric licensing on personal devices is unanswered; a crowd must never reach the live process                                                                                      | The church's licence answer, then a separate supervised feed process on its own port and hostname, LAN-only and live-only by default, songs only, no history                                                                               |
| **Messages to the booth**                                           | They land on the volunteer's screen during a service                                                                                                                              | A relay to operate sockets that changes nothing until the volunteer acts, never takes focus, rate limited                                                                                                                                  |
| **"Where are we" for greeters, run of show**                        | A service-time view of live state                                                                                                                                                 | The projection above                                                                                                                                                                                                                       |
| **Live look-ahead for interpreters**                                | It follows the live slide                                                                                                                                                         | The projection above with a whole-song variant. Before Sunday, interpreters read the plan (P1)                                                                                                                                             |
| **Presence** ("Maria is editing")                                   | A fan-out on the live process for every open editor; merges and operations already handle collisions                                                                              | A message on editor sockets, coalesced per presentation, once P2's load measurements leave room                                                                                                                                            |
| **Chord charts**                                                    | `Section.chords` is per section and the parser drops chord positions (`lyrics.ts:318-328`)                                                                                        | Chords stored per lyric line, importer updates, then a chord view in Words                                                                                                                                                                 |
| **Imports on a phone** (PowerPoint, PDF, ProPresenter)              | Heavy jobs refused while live, and the import report needs a bigger screen (design/15 "PowerPoint imports")                                                                       | A phone layout of the import card if churches ask; the sermon deck keeps coming from a laptop                                                                                                                                              |
| **Canvas layout, themes, looks and fonts on a phone**               | Precision work on a 312 px canvas, and looks reach the screens' config                                                                                                            | Nothing planned: a tablet or computer does this                                                                                                                                                                                            |
| **Offline plan editing and background sync**                        | A plan change applied days later can undo someone else's rebuild                                                                                                                  | Operation-based sync with a review step ("3 changes from Tuesday: apply?")                                                                                                                                                                 |
| **Push notifications** ("the plan changed")                         | A push service and the WAN; on iOS only for installed apps                                                                                                                        | A Web Push sender in the library process, opt-in per phone, never on the live path                                                                                                                                                         |
| **"Show until" dates on announcement slides**                       | A date rule in cue building for one convenience; per-service decks (§2.10) avoid most stale slides                                                                                | A slide or item field honoured by `cues.ts`, with goldens                                                                                                                                                                                  |
| **A native app**                                                    | Separate apps fall behind; the web app from the same image stays current through the version guard                                                                                | Nothing planned                                                                                                                                                                                                                            |
| **User accounts**                                                   | ADR 0010; passes name devices without accounts                                                                                                                                    | An ADR replacing ADR 0010 (milestones.md lists cloud sync and accounts as a later candidate)                                                                                                                                               |

## 12. Open questions for the church

1. **Who edits from a phone?** Everyone with the edit PIN (P0 to P2), or only named phones with passes (P3)?
   Should P3 come before P2?
2. **Musicians**: do you want the view PIN in P1? Should their phones see sermon and announcement decks
   with or without slide notes (default: without)?
3. **Licensing**: does your CCLI (or local) licence cover song words kept on team members' own phones for
   rehearsal, or must the offline copy be limited to the next plan?
4. **The last hour**: should phone changes to the next plan in the hour before its service be warned (the
   default), blocked, or neither? Is 12 hours right for the "media must be ready" rule?
5. **Service times**: what are your service times, and do you hold more than one service on a day?
6. **Templates**: who makes the announcement templates, and which do you need (event, notice, photo with
   caption, welcome)?
7. **Photos of people**: what is your consent policy for photos from personal camera rolls, children above
   all? Is the Inbox (hidden from musicians until an editor approves) enough?
8. **Phones in use**: which iOS and Android versions do your volunteers have? That sets the oldest version
   tested.
9. **Offline copy**: is 14 days without contact the right limit before a phone hides its copy?
10. **History**: is "newest 50 or 30 days, at most 200" enough for songs and plans, or should plans keep a
    year?
11. **The NAS**: which model is it (CPU cores, free space)? It decides whether the 25 MB threshold, the job
    pacing and the free-space floor are enough while a service runs.
12. **Church Wi-Fi**: can the router or DSM answer the ordo hostname with the NAS's LAN address (split
    DNS)? Who looks after the router?
13. **Passes**: is a passkey (Face ID or fingerprint) acceptable to your team, and is a new dependency on
    the hub for it acceptable? Are 90 days unused and one year in total right? Who reviews the list when
    volunteers leave?
14. **Languages**: which languages should the phone screens speak first, and is one of them right to left?

## 13. Risks

1. **A phone blocks the next service** (media not ready, an offline copy no longer complete, a change
   minutes before). Mitigated by readiness on both screens, the 12-hour rule, job priority for the next
   plan, the PC's "download again" line and the free-space floor.
2. **Phones load the live process during a service.** Mitigated by pokes instead of deltas, pushes instead
   of polls, budgets while live and socket caps; the rehearsal gate with real phones and the real library
   decides.
3. **A lost phone exposes or erases.** Mitigated by the `light` cap, the 14-day expiry, wipe on PIN change
   and revocation, and passes with passkeys in P3.
4. **Edits do nothing or change too much.** Mitigated by the true background override, per-service order
   and hidden slides as one playlist write, and the "used in N plans" step for song-wide changes.
5. **Previews are not as they will look on an iPhone** (WebKit text measurement, a late font, a
   rendition). Mitigated by the line-break test, the honest labels and the same rasterizer.
6. **Scope and timing**: about fifteen hub changes on a system that has not run its first service.
   Mitigated by landing hub changes after the first service, one per weekday, each with its test and the
   `phones.enabled` switch.
7. **More people asking for the edit PIN** before P3. Mitigated by the view PIN in P1.
8. **The Live now strip grows into a service view.** Held off by the `venue` message having no field for
   it, by §10 item 9 and by §11: any service-time feature needs its own ADR.
9. **A second set of views to maintain.** Mitigated by shared stores and operations (no second save path)
   and the phone projects in CI.

## 14. Documents to update with each phase

| Document                                                 | Change                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `design/15-operator-app.md`                              | "iPad editing" gains "Phones": the layout class, compact views, capped sign-in, the forced-profile guard, playlist operations, the PC's marks |
| `design/11-domain-model.md`                              | The item fields, the background override, `updatedBy`, `serviceTime`, `Media.preview`, playlist revisions, the tag conventions                |
| `design/12-hub.md`                                       | Caps, pokes and `venue`, renditions, gzip, playlist revisions, job pacing, upload hygiene, the free-space floor, budgets; passes in P3        |
| `design/13-protocol.md`                                  | `venue` and `library.poke`                                                                                                                    |
| `design/21-security.md`                                  | Caps per route, `Origin` checks, the LAN exemption, `view` redaction and file scope, the corrections of §4; passes and WebAuthn in P3         |
| `design/22-deployment.md`                                | Split DNS for church Wi-Fi                                                                                                                    |
| `design/23-testing.md`                                   | The phone and tablet projects and the phone gates                                                                                             |
| `prd/03-editor.md`, `prd/09-security-and-remote-prep.md` | "On a phone"; caps, the view PIN and passes as credentials                                                                                    |
| `milestones.md`                                          | P0 to P3 with their gates                                                                                                                     |
| ADR 0015 (P3)                                            | Device passes for phones: scoped, revocable, passkey-backed, never live, never tokens                                                         |

## 15. Changes after the completeness review

The review of the synthesis (2026-11-07) found claims the code contradicts and gaps. What changed:

- **Live now showed slide text**: the strip used `liveLabel`, the first text of the live slide. Now the
  `venue` message has no such field (§2.2, §3.3), and a test checks the strip.
- **"Phones add no live-process work"** was wrong: the live process is the front door. Now §5.3 lists the
  cost, capped sockets get pokes, Live now is pushed, the double stringify goes, writes have a byte budget
  while live, and the rehearsal gate measures it.
- **Media writes refetched output config** whenever no logo was set, and **fonts could be deleted** under a
  service: `affectsContext` is narrowed and live fonts are locked (P0).
- **"Background for this service" did nothing** for songs with per-slide backgrounds: the item background
  becomes a true override (§3.5).
- **An arrangement for this service was two non-atomic writes**: it is now the item's `sections`, one
  playlist write. Hide and duplicate on a song are no longer silently song-wide (§2.7, §3.5).
- **`savedBy` was not in the library copy**: `updatedBy` is added (§3.5).
- **"Nothing is deleted from a phone" held only in the UI**: the hub's `light` cap refuses deletes, fonts,
  themes, imports and folders (§3.2).
- **The offline copy had no limit** and sign-out kept it: the 14-day expiry and the wipe rules (§3.10).
- **"Remember off" did not end 12-hour sessions**: capped sign-ins clear the device cookie.
- **The pass cookie and table names were taken**: `ordo_pass` and `passes`.
- **The CSRF claim did not match the code**: `Origin` and header checks are now a P0 change.
- **The cap leaked through the layout**: the compact layout needs a non-full profile, and the cap comes
  from the screen size, not the viewport (§3.1, §3.2).
- **Moving output tokens** was not needed for phones (edit sessions never receive them) and touched the
  venue PC's launch path: dropped.
- **Split DNS** is an install item (§5.4). **Search folding** uses `\p{Mn}`. **Pixel-equal previews** became a
  line-break test with an honest label (§3.8). **Service times** and the venue's time zone are added.
  **Stage previews** follow the plan's order. **Venue PC changes** are listed with their tests (§3.12).
  **Save time** is budgeted by body size, with compressed bodies.
- **Gaps covered**: readiness and the next service (§5.2), the free-space floor, drafts written as you type,
  revision caps, restoring a plan that names deleted items, templates into a per-service deck, the view PIN
  for musicians, passkeys for passes, issuing passes away from a running service, the missing states
  (§2.12), the phone platform items (§3.11), focus in sheets, Voice Control, pinch zoom, mirrored
  controls, fonts by script, the catalog gap, location removal from originals with a backfill, the Inbox,
  file scope for `view`, the claim bucket and `/health`.
- **Not taken**: presence and "show until" dates are in §11 with reasons; the venue PC's playlist editor,
  not the Go live area, carries the marks.
