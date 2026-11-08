# PRD 10: Phones, outside the service

Team members use their own phones during the week to look at the library and to make small changes:
from home, on the bus, at rehearsal. Running a service stays on the venue PC. A phone can look at
everything and change a little; it never changes what is live. The design is
[design/28](../design/28-mobile.md); its phases P0 to P3 are referred to below.

## Users

| User                     | Needs on a phone                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Worship lead             | Find any song, see Sunday's plan, add or reorder songs, pick the order for this service, fix a lyric, swap a background |
| Pastor or speaker        | Check that the sermon deck looks right, fix a typo, hide a slide for this service, write stage notes                    |
| Musicians                | Read the plan, keys and orders, and the words by section, without being able to change anything                         |
| Tech volunteers          | Check slides under every look, see whether media is ready, fix small things while preparing                             |
| Communications volunteer | Add an announcement from a template with a photo from the camera roll; upload event photos                              |
| Interpreters             | Read the week's words ahead of time, right-to-left text shown correctly                                                 |

## Viewing the library (P1)

- Plans by date and time in the venue's time zone, the next one first, each with its readiness: "Ready", or
  what would make Go live fail or what to check (media still processing, a missing font, text that does
  not fit).
- A plan's items with their order for this service and key; a song's words by section; a deck's slides.
- Search by title, words, author, CCLI number or tag, from a field at the bottom of the screen; a match in
  the words shows the line.
- Slide previews drawn the way the screens draw them: the main screen, the lobby lower third, the stream
  key and the stage display with the next slide. Where a phone's browser may break a line differently,
  the preview says so.
- Media with its state in words ("Processing", "Waiting for the service to end").
- Reading works offline from the phone's copy, which says how old it is.

## Light changes (P2)

- Fix words in a slide, split or merge slides, find and replace, edit a stage note.
- Hide a slide in this service only, or everywhere; duplicate or move a slide.
- Add, remove and reorder plan items; pick a saved arrangement or a section order for this service.
- Set a background for this service, for one slide or for all slides of a song, from the library or the
  camera roll; replace an announcement picture.
- Add an announcement slide from a template (presentations tagged `template`) to this service's own deck.
- Create a song from pasted lyrics.
- Not on a phone: canvas layout, themes, looks, fonts, settings, imports, deletes, PINs.

## Safety

- The live playlist and its presentations are locked while live; a phone shows "Live at the venue"
  with the plan's name and the lock, never slide text.
- Every presentation and plan save is a revision; History restores any of them. Undo works within the
  session and after a save.
- Unsaved text is kept on the phone as it is typed. A change refused because its plan went live is kept
  and offered after the service.
- Two people changing the same song or plan: different parts are combined; the same line asks which to
  keep and can copy the phone's text; plan changes are re-applied to the newer plan.
- Changes that affect every plan using a song say how many plans and ask twice.
- Within the hour before a plan's service time a change warns first, and the venue PC's playlist editor
  marks changes made from phones. Media that is not ready cannot be added within 12 hours of a service.
- Phones never slow a service: heavy processing and large uploads wait until it ends, and the load of
  phones in use is measured at a rehearsal before each phase ships.

## Access

- P0 to P2: the edit PIN (or the operate PIN) on a phone gives a capped session that cannot run a service,
  delete, or change settings, fonts, themes or imports. Sessions last an hour; there is no "remember".
- P1: an optional view PIN for musicians: reading only, without deck notes or unapproved photos.
- P3: per-phone passes, issued from the iPad or the venue PC by QR code or invite link, unlocked with
  Face ID or a fingerprint, named in History, revocable one by one.
- A lost phone: change the PIN (P0 to P2) or revoke its pass (P3); the phone's copy is removed on its next
  contact. A phone that has not reached ordo for 14 days hides its copy until someone signs in.
- Photos lose their location data on upload and wait in an Inbox, hidden from musicians, until an editor
  uses or approves them.

## Accessibility and languages

- Usable with one hand: primary actions, search and sheets at the bottom; 44 px targets; text follows the
  phone's text size up to 200 %.
- VoiceOver, TalkBack, Voice Control and Switch Control can do everything, including reordering without
  dragging.
- Slide text in any direction is shown per paragraph; the phone screens can be translated, including
  right-to-left languages.

## Not now

Live control, a phone remote or clicker, GO or Next on a phone, a stage or confidence view on a phone, an
audience lyrics feed, booth messages, imports and canvas editing on a phone. design/28 §11 says why for
each and what it would need.

## Acceptance

- In a usability session the worship lead does every light change above one-handed on her own phone, and
  finds any song in under 10 seconds.
- Sunday's plan reads in airplane mode from the phone's copy.
- On five real slides, the main, lobby, stream and stage previews match the screens.
- A phone session cannot GO, clear, launch outputs, delete or change settings, even by crafting API calls.
- During a rehearsal service with 20 phones browsing and two uploading, every output reports zero missed
  vsync.
- A musician with the view PIN or a view pass reads the plan and sees no deck notes.
