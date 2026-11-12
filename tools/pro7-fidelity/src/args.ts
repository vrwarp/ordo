export type Pro7FidelityArgs = {
  sampleDir?: string;
  corpus: boolean;
  outDir: string;
  decks?: Set<string>;
  slides?: Map<string, Set<number>>;
  exportCompat: boolean;
  baselinePath?: string;
  writeBaselinePath?: string;
  ratchet: boolean;
  requireGain: boolean;
  maxSlideDrop: number;
  maxDeckDrop: number;
  worstCount: number;
};

export function parseArgs(argv: readonly string[], env?: NodeJS.ProcessEnv): Pro7FidelityArgs {
  const e = env ?? process.env;

  let sampleDir: string | undefined = e.ORDO_PRO7_SAMPLE_DIR || undefined;
  let corpusExplicit: boolean | undefined;
  let outDir = '/tmp/pro7-fidelity';
  let decks: Set<string> | undefined;
  let slides: Map<string, Set<number>> | undefined;
  let exportCompat = true;
  let baselinePath: string | undefined;
  let writeBaselinePath: string | undefined;
  let ratchet = false;
  let requireGain = false;
  let maxSlideDrop = 0.005;
  let maxDeckDrop = 0.002;
  let worstCount = 12;

  const parseSlideSpec = (raw: string) => {
    slides ??= new Map();
    const parts = raw
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      const colonIdx = part.indexOf(':');
      if (colonIdx < 0) continue;
      const deckKey = part.slice(0, colonIdx).trim().toLowerCase();
      const spec = part.slice(colonIdx + 1).trim();
      let set = slides.get(deckKey);
      if (!set) {
        set = new Set();
        slides.set(deckKey, set);
      }
      for (const token of spec
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)) {
        if (token.includes('-')) {
          const [startStr, endStr] = token.split('-');
          const start = Number.parseInt(startStr!, 10);
          const end = Number.parseInt(endStr!, 10);
          if (!Number.isNaN(start) && !Number.isNaN(end)) {
            const min = Math.min(start, end);
            const max = Math.max(start, end);
            for (let i = min; i <= max; i++) set.add(i);
          }
        } else {
          const num = Number.parseInt(token, 10);
          if (!Number.isNaN(num)) set.add(num);
        }
      }
    }
  };

  const addDecks = (raw: string) => {
    decks ??= new Set();
    for (const name of raw
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)) {
      decks.add(name);
    }
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    i++;

    if (arg === '--sample-dir') {
      sampleDir = argv[i++];
    } else if (arg.startsWith('--sample-dir=')) {
      sampleDir = arg.slice('--sample-dir='.length);
    } else if (arg === '--corpus') {
      corpusExplicit = true;
    } else if (arg === '--no-corpus') {
      corpusExplicit = false;
    } else if (arg === '--out') {
      outDir = argv[i++] ?? outDir;
    } else if (arg.startsWith('--out=')) {
      outDir = arg.slice('--out='.length);
    } else if (arg === '--decks') {
      const val = argv[i++];
      if (val !== undefined) addDecks(val);
    } else if (arg.startsWith('--decks=')) {
      addDecks(arg.slice('--decks='.length));
    } else if (arg === '--slides') {
      const val = argv[i++];
      if (val !== undefined) parseSlideSpec(val);
    } else if (arg.startsWith('--slides=')) {
      parseSlideSpec(arg.slice('--slides='.length));
    } else if (arg === '--export-compat') {
      exportCompat = true;
    } else if (arg === '--no-export-compat') {
      exportCompat = false;
    } else if (arg.startsWith('--export-compat=')) {
      exportCompat = arg.slice('--export-compat='.length) !== 'false';
    } else if (arg === '--baseline') {
      baselinePath = argv[i++];
    } else if (arg.startsWith('--baseline=')) {
      baselinePath = arg.slice('--baseline='.length);
    } else if (arg === '--write-baseline') {
      writeBaselinePath = argv[i++];
    } else if (arg.startsWith('--write-baseline=')) {
      writeBaselinePath = arg.slice('--write-baseline='.length);
    } else if (arg === '--ratchet') {
      ratchet = true;
    } else if (arg === '--no-ratchet') {
      ratchet = false;
    } else if (arg === '--require-gain') {
      requireGain = true;
    } else if (arg === '--no-require-gain') {
      requireGain = false;
    } else if (arg === '--max-slide-drop') {
      const val = argv[i++];
      if (val !== undefined) maxSlideDrop = Number.parseFloat(val);
    } else if (arg.startsWith('--max-slide-drop=')) {
      maxSlideDrop = Number.parseFloat(arg.slice('--max-slide-drop='.length));
    } else if (arg === '--max-deck-drop') {
      const val = argv[i++];
      if (val !== undefined) maxDeckDrop = Number.parseFloat(val);
    } else if (arg.startsWith('--max-deck-drop=')) {
      maxDeckDrop = Number.parseFloat(arg.slice('--max-deck-drop='.length));
    } else if (arg === '--worst') {
      const val = argv[i++];
      if (val !== undefined) worstCount = Number.parseInt(val, 10);
    } else if (arg.startsWith('--worst=')) {
      worstCount = Number.parseInt(arg.slice('--worst='.length), 10);
    }
  }

  const corpus = corpusExplicit ?? sampleDir === undefined;

  return {
    sampleDir,
    corpus,
    outDir,
    decks,
    slides,
    exportCompat,
    baselinePath,
    writeBaselinePath,
    ratchet,
    requireGain,
    maxSlideDrop,
    maxDeckDrop,
    worstCount,
  };
}
