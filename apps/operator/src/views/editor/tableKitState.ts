/**
 * Whether the editor canvas has loaded its table kit (SlideCanvas.tsx loads the renderer's table module with
 * the first table it shows). Its own module so the editor's inspect hook (inspect.ts) reads it without the
 * canvas and its imports.
 */
let loaded = false;

export function tableKitLoaded(): boolean {
  return loaded;
}

export function markTableKitLoaded(): void {
  loaded = true;
}
