export function AlignIcon({ align }: { align: 'left' | 'center' | 'right' }) {
  if (align === 'left') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M2 3h12v2H2zm0 4h7v2H2zm0 4h10v2H2z" />
      </svg>
    );
  }
  if (align === 'center') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M2 3h12v2H2zm2.5 4h7v2h-7zm1 4h5v2h-5z" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 3h12v2H2zm5 4h7v2H7zm2 4h5v2H9z" />
    </svg>
  );
}

export function VAlignIcon({ valign }: { valign: 'top' | 'middle' | 'bottom' }) {
  if (valign === 'top') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1 2h14v2H1zm3 4h8v2H4zm2 4h4v2H6z" />
      </svg>
    );
  }
  if (valign === 'middle') {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1 7h14v2H1zm3-4h8v2H4zm2 8h4v2H6z" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 12h14v2H1zm3-4h8v2H4zm2-4h4v2H6z" />
    </svg>
  );
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toH = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toH(r)}${toH(g)}${toH(b)}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: Number.parseInt(m[1]!, 16), g: Number.parseInt(m[2]!, 16), b: Number.parseInt(m[3]!, 16) }
    : { r: 255, g: 255, b: 255 };
}
