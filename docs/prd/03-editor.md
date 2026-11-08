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
- Undo and redo within an editing session; save creates a presentation revision
  ([prd/05](05-library-media-import.md), version history).
- Keyboard: arrow nudges, Shift for 10 px, Ctrl+D duplicate, Delete, Ctrl+Z, Ctrl+Y,
  Ctrl+S.
- Alignment guides and snapping to the canvas centre, edges and other objects.
- Preview: a "Send to preview" renders the selected slide (as currently drafted, saved or
  not) on a chosen audience output, when no playlist is live; "Clear preview" returns the
  output to idle, as does the next Go live. The control is disabled while a playlist is live.
  Thumbnails elsewhere are CSS approximations.

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
