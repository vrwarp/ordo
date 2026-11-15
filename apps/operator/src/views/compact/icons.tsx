/**
 * The compact layout's icons (design/28 mockups, `28-mobile/` build script): 24 px line icons in the text's
 * colour, hidden from assistive technology (each sits beside its visible label).
 */
export type IconName = 'plans' | 'library' | 'media' | 'more' | 'back' | 'previous' | 'next';

function paths(name: IconName) {
  switch (name) {
    case 'plans':
      return (
        <>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4M8 14h3" />
        </>
      );
    case 'library':
      return (
        <>
          <rect x="3.5" y="8.5" width="17" height="12" rx="2.5" />
          <path d="M6 5.5h12M8.5 2.5h7" />
          <path d="M10 12.5v5l4-2.5z" />
        </>
      );
    case 'media':
      return (
        <>
          <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
          <circle cx="9" cy="10" r="1.8" />
          <path d="M20.5 16.5l-5-5-9.5 8.5" />
        </>
      );
    case 'more':
      return (
        <>
          <circle cx="5.5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18.5" cy="12" r="1.7" />
        </>
      );
    case 'back':
    case 'previous':
      return <path d="M15 5l-7 7 7 7" />;
    case 'next':
      return <path d="M9 5l7 7-7 7" />;
  }
}

export function Icon({ name }: { name: IconName }) {
  const filled = name === 'more';
  return (
    <svg
      className={`compact-icon${filled ? ' filled' : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {paths(name)}
    </svg>
  );
}
