/**
 * The arguments the suite starts Chromium with (`playwright.config.ts`, every Chromium project). A spec that needs a
 * variation names the lists here and its own additions: `test.use({ launchOptions: { args } })` REPLACES the config's
 * list (Playwright does not merge them; the headless shell's own defaults, a few of which repeat these, are all that
 * stays).
 */

/** What asks Chromium for WebGPU and for WebGL through SwiftShader (no machine of the suite has a GPU). */
export const GPU_ARGS: string[] = [
  '--enable-unsafe-webgpu',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--enable-features=Vulkan',
];

/** Colour, text, timers and the permission prompts: what every window of the suite needs, GPU or not. */
export const COMMON_ARGS: string[] = [
  '--force-color-profile=srgb',
  // Text with the fonts' own advances. Playwright's headless shell defaults to full hinting, which rounds
  // every glyph advance to a whole pixel: the CI runner's outputs drew a verse line 0.25 % to 0.6 %
  // narrower than the fidelity harness's page (which draws unhinted, `unhintedFontconfig`), SSIM 0.971
  // (e2e/pptx-native.spec.ts cue 1), and narrower than Chrome draws it under fontconfig's default, slight
  // hinting, which keeps the advances. With the switch the outputs keep them on every machine.
  '--font-render-hinting=none',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--use-fake-ui-for-media-stream',
  '--disable-popup-blocking',
];

/** The config's list. */
export const CHROMIUM_ARGS: string[] = [...GPU_ARGS, ...COMMON_ARGS];

/**
 * For a spec whose windows are all `renderer=2d` (Canvas 2D, drawn on the CPU): no GPU switches and no GPU, so no GPU
 * process work at all. On two CPUs (a CI runner) the SwiftShader process of `CHROMIUM_ARGS` takes about 170 % of a CPU
 * for one idle 1920 x 1080 window, and `--disable-gpu` beside the GPU switches does not stop it.
 */
export const CPU_ONLY_ARGS: string[] = [...COMMON_ARGS, '--disable-gpu'];
