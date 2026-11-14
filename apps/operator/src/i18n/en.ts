/**
 * The English strings a phone needs before the compact chunk (design/28 §6 "UI language"): the sign-in, the
 * first-run note and the shell's wait, in the entry. The compact views' strings are in enCompact.ts, which only
 * the compact chunk loads (src/i18n/compactStrings.ts), so the venue PC never downloads them. A plural is
 * `{ one, other }`, chosen by Intl.PluralRules from the `n` parameter; `{name}` is a parameter. The regular layout
 * (the venue PC, the iPad) keeps its inline English strings (design/28 §6 "Known gap"). P1 adds the next
 * languages beside these files, the override in More and the direction.
 */
export const en = {
  'shell.loading': 'Getting the library…',
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
  // ---- first run on a phone ----
  'setup.phone': 'ordo is not set up yet. Set it up on the venue PC: it sets the PINs.',
} as const;
