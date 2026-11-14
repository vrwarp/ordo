/**
 * The compact views' English strings (design/28 §6 "UI language"): the frame, More, the sheets, the P0 tab
 * bodies, the Live now strip and the freshness line, in the owner's and the design's words. Loaded with the
 * compact chunk (src/i18n/compactStrings.ts registers them), never by the venue PC.
 */
export const enCompact = {
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
  'library.more': { one: '1 more: search to find it.', other: '{n} more: search to find them.' },
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
} as const;
