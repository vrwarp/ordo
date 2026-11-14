import { enCompact } from './enCompact.ts';
import { addStrings } from './index.ts';

/**
 * The compact views' strings, registered when the compact chunk (or a module only it uses: lib/liveStrip.ts,
 * lib/freshness.ts) loads. Imported for its effect.
 */
addStrings('en', enCompact);
