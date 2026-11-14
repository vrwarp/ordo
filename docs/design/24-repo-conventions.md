# Design 24: Repository layout and conventions

## Layout

```
ordo/
  apps/
    hub/            Fastify + ws + better-sqlite3, Dockerfile
    operator/       React, Vite
    output/         Vite, main + workers
    stage/          React, Vite
  packages/
    domain/  protocol/  live-state/  renderer/  cache/  audio/  surfaces/  importers/  ui/
  tools/
    soak/           soak runner
    fixtures/       generated test media and documents
    pptx-fidelity/  PowerPoint fidelity harness, census and the golden-pptx census ratchet
    pro7-fidelity/  ProPresenter 7 fidelity harness and ratchet
    geom-gen/       preset geometry generator and its golden
    golden-docker.sh, golden-from-artifact.sh   renderer goldens in the pinned container (design/23)
    *.py            the golden-pptx downloader and manifest builder (refresh tools; never run in CI)
  golden-pptx/      public decks for the census ratchet (sources and takedown notice in its README)
  e2e/              Playwright specs (tsconfig.e2e.json)
  docs/             this suite
  .github/workflows/ci.yml, docker-pr.yml, docker-publish.yml, pages.yml, audit.yml
  pnpm-workspace.yaml  package.json  tsconfig.base.json  biome.json
```

## Tooling

- Node 22, pnpm 10, TypeScript 5 strict, Vite 6, Vitest, Playwright, Biome for lint and
  format, Zod, Zustand, Dexie, react-konva, protobufjs, fast-xml-parser, Fastify, ws,
  better-sqlite3, pino, argon2.
- `pnpm dev` starts the hub on `https://localhost:8443` with a self-signed certificate
  and host routing by a `?role=` query for convenience, plus Vite dev servers; `pnpm
  dev:origins` adds hosts entries for `*.ordo.test` and serves each role on its origin for
  isolation testing.
- **Bundle budget.** `node tools/bundle-report.mjs` prints what each built app (operator, output, stage)
  loads before its first paint (`initial`: index.html's entry and the chunks it imports statically, with
  gzip), its CSS, its workers and its lazy chunks (named by their source maps: the PowerPoint `importer`,
  the `table drawer`); `--json <file>` writes the same. CI runs it with `--check` after `pnpm build`: an
  app's initial JavaScript may grow at most 2 % over `tools/bundle-baseline.json`. New code the first paint
  does not need is loaded when first used: a page opened before or after a service (Setup, the settings
  pages: `React.lazy` in `App.tsx`; the service worker precaches every chunk, so they open offline), an M9
  object kind's drawer (`registerShapeDrawerLoader`, loaded by the workers' slide prepare steps and the
  editor canvas before they draw). A PR whose growth is accepted re-records the baseline with `--write`
  and gives the numbers in its description.

## TypeScript that Node can run as it is

Node 22 runs a `.ts` file by stripping its types, without compiling it, and rejects syntax that has
no JavaScript of its own (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). A worker thread or a tool started
without the tsx loader meets that rule, so every package keeps to erasable syntax: no parameter
properties (`constructor(private readonly x: X)`: declare the field and assign it in the
constructor), no `enum`, no `namespace` with code, no `import x = require()`. `erasableSyntaxOnly` in
`tsconfig.base.json` makes `pnpm typecheck` fail on them, and Biome's `style/noParameterProperties`
is an error in `pnpm lint`, tests and e2e specs included.

`pnpm typecheck` checks the tests as strictly as the code they test: a package's `tsconfig.json` covers
`src` (and the tests in it), its `tsconfig.test.json` what lies outside `src` with Node's types
(`apps/operator/test`, the renderer's `golden/` and `bench/`, `apps/output/bench`,
`apps/demo/scripts`), and the root `tsconfig.e2e.json` the e2e specs and the Playwright and Vitest
configs. A test that calls a function with the wrong arguments, or builds a fixture with fields the
schema does not have, fails the check rather than quietly testing something else.

## Coding rules that protect the frame budget

- `packages/renderer` and the output main thread: no allocation in per-frame code paths.
  A lint rule (custom Biome plugin or an ESLint rule in that package only) flags object
  literals, array literals, closures and template strings inside functions named
  `frame*` or marked `/* @hot */`.
- No `await` inside the frame loop. Promises resolve into pre-allocated slots.
- Every message type is a Zod schema; no untyped `postMessage`.
- Reducer is pure; side effects live in bus adapters.
- Feature flags are settings, not build flags.

## How Claude Code sessions should work in this repo

- One milestone task per session or PR ([milestones.md](../milestones.md)). Start by
  reading the PRD and design sections the task cites.
- Run `pnpm test` and the relevant `pnpm e2e` project before pushing.
- Any deviation from a design document is made in the same PR as a new ADR plus an edit
  to the design doc. Docs and code move together.
- Commit messages: `area: imperative summary` (`renderer: pre-allocate crossfade uniforms`).
- Never commit venue content, PINs, tokens or certificates. The one corpus of real decks in the repository,
  `golden-pptx/`, is public material with its sources recorded; decks a venue shares stay out.
- Tests stay honest: no retried key presses or relaxed floors to get past a flake (find the cause, design/23),
  wall-clock bounds through `budgetMs`, 50 ms task gates in the benches, and expected golden images only from
  the pinned container.
