/**
 * The compact layout's English strings (design/28 §6 "UI language"): every string the phone's shell, sheets,
 * P0 tab bodies and phone sign-in show, in the owner's and the design's words. A plural is `{ one, other }`,
 * chosen by Intl.PluralRules from the `n` parameter; `{name}` is a parameter. The regular layout (the venue PC,
 * the iPad) keeps its inline English strings (design/28 §6 "Known gap"). P1 adds the next languages beside this
 * file, the override in More and the direction.
 */
export const en = {
  // ---- the frame ----
  'tab.plans': 'Plans',
  'tab.library': 'Library',
  'tab.media': 'Media',
  'tab.more': 'More',
  'tab.bar': 'Sections',
  'title.plans': 'Plans',
  'title.library': 'Library',
  'title.media': 'Media',
  back: 'Back',
  'shell.loading': 'Getting the library…',
  // ---- More ----
  'more.title': 'More',
  'more.venue': 'ordo at {host}',
  'more.signedIn': 'Signed in on this phone',
  'more.version': 'ordo {version}',
  'more.demoAbout': 'About the demo',
  'more.demoReset': 'Reset the demo',
  'more.signOut': 'Sign out',
  // ---- Library ----
  'library.search': 'Search presentations',
  'library.searchLabel': 'Search presentations: title, lyrics, CCLI, tag',
  'library.locked': 'Live · locked',
  'library.empty': 'No songs yet.',
  'library.noMatch': 'No presentations match “{q}”.',
  'kind.song': 'Song',
  'kind.slides': 'Slides',
  'kind.loop': 'Announcement loop',
  // ---- Media ----
  'media.empty': 'No pictures yet.',
  'media.kind.image': 'Picture',
  'media.kind.video': 'Video',
  'media.kind.audio': 'Audio',
  'media.state.uploaded': 'Queued',
  'media.state.processing': 'Processing',
  'media.state.ready': 'Ready',
  'media.state.failed': 'Failed',
  'media.audioNote': 'Audio plays on the venue PC.',
  // ---- Plans ----
  'plans.empty': 'No plans yet. Plans are made on a computer or iPad.',
  'plans.items': { one: '{n} item', other: '{n} items' },
  'plans.rowMeta': '{date} · {items}',
  'plans.live': 'Live at the venue',
  'plans.liveBanner': 'Live at the venue: locked until the service ends',
  'plans.noItems': 'No items yet.',
  'plans.missing': 'This plan is not in the library.',
  // ---- previews ----
  'preview.previous': 'Previous',
  'preview.next': 'Next',
  'preview.position': 'Slide {n} of {total}',
  'preview.noSlides': 'No slides yet.',
  'preview.missing': 'This presentation is not in the library.',
  // ---- Live now ----
  'live.strip': 'Live at the venue: {name} · {n} locked',
  'live.unknownOffline': 'Live status unknown: offline',
  'live.unknownUnreachable': "Live status unknown: can't reach ordo",
  'live.sheetTitle': 'Live at the venue',
  'live.sheet': {
    one: 'A service is running at the venue. {name} and its {n} presentation are locked until it ends. You can still look at everything and change anything else.',
    other:
      'A service is running at the venue. {name} and its {n} presentations are locked until it ends. You can still look at everything and change anything else.',
  },
  'live.sheetUnknown':
    'This phone cannot tell whether a service is running at the venue. Presentations a service uses stay locked until it ends.',
  // ---- freshness ----
  'fresh.offlineAt': 'Offline · copy from {when}',
  'fresh.unreachableAt': "Can't reach ordo · copy from {when}",
  'fresh.offlineHere': 'Offline · copy on this phone',
  'fresh.unreachableHere': "Can't reach ordo · copy on this phone",
  // ---- sign-in on a phone ----
  'signin.prompt': 'Enter the operate or edit PIN',
  'signin.phoneLine':
    'On a phone you can look at everything and make small changes. Services run from the venue PC.',
  'signin.host': 'ordo at {host}',
  'signin.homeScreen': 'Using ordo from your home screen? Sign in there; it keeps its own copy.',
  'signin.wrong': 'Wrong PIN.',
  'signin.lockedEveryone': 'Too many wrong PINs were tried on ordo. Try again at {time}.',
  'signin.lockedNetwork':
    'Too many wrong PINs from this network. Try again at {time}. Everyone on the same Wi-Fi may share this wait.',
  'signin.lockedSoon': 'Too many wrong PINs. Try again in a few minutes.',
  'signin.reSignIn': 'Phones now sign in for an hour at a time. Enter the PIN again.',
  'signin.delete': 'Delete',
  // ---- first run on a phone ----
  'setup.phone': 'ordo is not set up yet. Set it up on the venue PC: it sets the PINs.',
} as const;
