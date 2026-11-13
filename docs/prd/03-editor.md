# PRD 03: Presentation editor

A per-slide editor in the ProPresenter style, used in the venue or from home through the
edit PIN. The editor is part of the operator app but is disabled for presentations that
belong to the live playlist.

## Presentations

- A presentation has a title, a type (song, slides, announcement loop), optional metadata
  (author, CCLI number, copyright, key, tempo), a default background, a default theme, an
  ordered list of sections, and each section an ordered list of slides.
- Song presentations are created from lyrics text: pasted or imported, split into sections
  by labels (`Verse 1`, `Chorus`, `Bridge`, `Tag`, `Pre-Chorus`, `Ending`) and into slides
  by blank lines or a lines-per-slide setting (default 2 to 4, per presentation).
- Slides presentations (sermon, announcements) are free-form.
- Announcement loop presentations auto-advance: each slide has a duration (default 8 s),
  and the loop repeats until cleared or the next GO.

## Sections and arrangements

- Sections are labelled groups. The lyric parser recognises common labels and their short
  forms (V1, C, B, PC, T, E) in English.
- An arrangement is an ordered list of section references (for example V1 C V2 C B C C).
  The default arrangement is the authoring order. Playlists reference a presentation plus
  an arrangement; adding a presentation to a playlist offers the saved arrangements or a
  new one for this service only.
- Editing a section's slides changes every arrangement that uses it.

## Slide editor

Canvas at the output's logical size (1920x1080 by default, resolution-independent
coordinates in the data model), with the slide's background shown behind.

Objects, in z-order, each selectable, movable, resizable, rotatable:

| Object   | Properties                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text box | Position, size, text, font family, size, weight, style, colour, alignment (horizontal and vertical), line height, letter spacing, outline (width, colour), shadow (offset, blur, colour), padding, fill colour and opacity, corner radius |
| Image    | Position, size, media reference, fit (contain, cover, stretch), opacity, corner radius                                                                                                                                                    |
| Shape    | Rectangle, ellipse, line, PowerPoint shapes (geometry shown read-only); fill (solid colour or gradient), stroke (width, colour, dash, arrowheads on open lines), shadow, opacity, corner radius                                           |

- Multiple text boxes per slide. The first text box of a song slide is the lyric box and
  is what the lower-third and stage looks read.
- Themes: a named set of default object styles plus a default lyric box geometry. Songs
  inherit the theme; a per-slide override is stored as the difference and shown with a
  marker. "Reset to theme" removes overrides. Applying a theme to a presentation rewrites
  nothing until the user confirms.
- Fonts: the family picker lists fonts uploaded to the hub and Google Fonts added via
  search ([prd/05](05-library-media-import.md)). Every output loads the same font files.
- Align to slide and Screen placement (Center Screen, Lower Third, Bottom Third, Top Banner) move the whole
  selection together (a shape and its text, a table, a group), by what the screens show of a turned box,
  which stays turned; on a 4:3 deck they work inside the deck's own area. They are in the Tune drawer's
  Object panel and, for a selection of several objects, in the floating bar's Align menu.
- Copy and paste: text keeps its formatting between boxes and from Bible Gateway, Word or a web page;
  slide objects paste onto another slide (also in another tab). A slide holds what the screens can draw,
  200 objects and 16 pictures: adding past that is refused with a message instead of the new object
  silently missing on the screens. Something pasted that the editor cannot use is left out, and a part of
  the editor that fails to draw shows a message there while the rest of the app, the live controls
  included, keeps working.
- Undo and redo within an editing session; save creates a presentation revision
  ([prd/05](05-library-media-import.md), version history).
- Keyboard: arrow nudges, Shift for 10 px, Ctrl+D duplicate, Delete, Ctrl+Z, Ctrl+Y,
  Ctrl+S. After editing a text box's words on the slide, Escape ends the editing and the keys act on the
  box again (an arrow moves it, Delete deletes it, a second Escape drops the selection); they never edit
  letters the volunteer cannot see. With Find and replace open the slide keeps every shortcut.
- Typing Chinese, Japanese or Korean: the input method's candidate window opens by the text being typed,
  and Escape or Enter while choosing a candidate belong to the input method (they do not end the editing,
  jump to the next Find match or split a Lyric Script slide).
- Find and replace is a card at the top right of the slide area, never over the slide list or the side
  panel; clicking a match opens its slide and puts the words in editing on the slide with the match
  selected.
- The Background button in the top bar replaces the slide's background as the Slide panel's Replace…
  does: on a slide imported from PowerPoint the picked picture or video shows (the slide's own PowerPoint
  background is replaced), one undo step.
- Readability choices on a song's lyrics (Clean, Shadow, Outline, Outline + shadow), from the bar over the
  text or the side panel, stay as chosen when the song's theme changes.
- Songs open in the Lyric Script on a desktop: each slide's words in a field, by section. Typing there
  keeps the slide's formatting: bold, italic and colours stay on their words, and automatic verse numbers
  and bullets stay automatic (they are never typed into the words). Split at Cursor (✂, Alt+Enter) cuts
  only where the caret is: at the end of a slide it starts an empty next slide, and it never cuts a word
  the volunteer did not choose; Auto-Split (2 lines) and '---' and Enter split by lines; every split keeps
  the formatting on both slides.
- Alignment guides and snapping to the canvas centre, edges and other objects.
- Preview: the editor shows the selected slide as drafted under every look (under the canvas, the stage
  view lens swaps the canvas for one look's screen and the "All 4 screens" tray shows every look; and
  the Previews page), drawn as the outputs draw it. Sending a slide from the editor to an
  idle output ("Send to preview") was removed from the editor by the owner's editor rework (#7,
  2026-11-09), deliberately; the hub's `preview` relay and the outputs' handling of it remain, unused by
  the UI. Thumbnails elsewhere are CSS approximations.

## On an iPad

The worship lead can do all of this from home on an iPad in Safari, with the edit or operate PIN:
library and search, the editor, playlists and arrangements, imports, media and fonts, and a Previews
page showing each slide on the main screen, the lobby lower third, the livestream key and the stage
display. The iPad never runs a service: there is no live view, Go live or output launch on it ("Go live
from the venue PC"); while a service runs, a "Live now" chip names it and its presentations are locked.
It installs to the home screen as a web app. See [design/15](../design/15-operator-app.md), "iPad
editing".

## Slide imports into the editor

- PPTX and PDF import produce one image slide per page. Each imported slide keeps a
  reference to the source file and page. An image slide from PPTX can be converted to an
  editable slide: the hub's text extraction supplies text boxes with approximate position
  and size, and the original rendered image is kept as the background until the user
  removes it. Fonts will not match the original; the UI says so.
- Lyrics import (SongSelect text or ChordPro) creates a song presentation with sections.

## Deferred (data model leaves room)

- Auto-shrink to fit, right-to-left text, per-object build animations, vertical text,
  bulleted lists with per-line styling.

## Acceptance

- Reproduce the venue's current song look and sermon title slide look pixel-close to
  ProPresenter at 1080p.
- A worship lead builds a full playlist from home in under 30 minutes using imports and
  arrangements, without the venue PC.
