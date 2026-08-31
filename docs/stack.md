# Astroix — Stack

Pochodzenie: grilling stackowy 2026-08-26; decyzja 1 (toolchain) przepisana na pivodzie 2026-08-31 (research #190, ratyfikacja #187). Każda decyzja poparta faktem z researchów agentowych (sierpień 2026) albo bezpośrednim uzasadnieniem produktowym. Premisa: czysty stan, najlepszy stack do TEGO produktu. Zasada nadrzędna od researchu core-reuse: **jeśli core Astro/Vite już to ma, nie piszemy tego** — pełna inwentaryzacja w `docs/core-reuse.md` (m.in.: martwe SSE, martwy prebuild chroma, odczyt contentu przez `runner.import('astro:content')`, żywe CSS route'u z `virtual:astro:dev-css`).

---

## Podsumowanie jednym spojrzeniem

| Warstwa | Wybór |
| --- | --- |
| PM / runner | **npm** (decyzja #190, ratyfikowana #187; mechanika migracji = lane czarterowy #188) |
| Runtime / CI | **Node 24 LTS**, `engines: >=22.12` |
| Język / format pakietu | **TypeScript strict, ESM-only**, `moduleResolution: bundler` |
| Kształt repo | **jeden pakiet** (`astroix`), czysty podział wewn.: core / node / client |
| Host compat | **`astro ^7` · `vite ^8` · zod 4 only** — nowe projekty, nie legacy |
| UI chrome | **React 19 + React Compiler 1.0**, `createRoot(shadowRoot)` |
| Styling | **Tailwind 4 + shadcn/ui na primitives Base UI**, motywy shadcn |
| Formularze | **TanStack Form** (+ zod) |
| Data / state chrome | **TanStack Query** (cache, invalidacja po eventach Vite WS `astroix:*`) + **zustand** (UI state) |
| Transport | **fetch (REST) + custom eventy Vite WS** (`astroix:*`) — patrz core-reuse |
| Editory | **CodeMirror 6** (markdown, raw CSS) |
| CSS parsing | **postcss** (czysty CSS) |
| Frontmatter | **`yaml` Document API** (format-preserving) |
| Unit testy | **vitest + happy-dom** |
| E2E | **@playwright/test** (CI, źródło prawdy) + **Playwright MCP** (lokalnie) |
| Lint/format | **Biome** |
| Build artefaktów | node: tsup-class (ESM, peers external) · **chrome: hybryda — prebuilt ESM w paczce, source + HMR z dev-checkoutu (ADR-0001)** *(wygasłe pivodem 2026-08-31 — ADR-0004)* |
| Publikowanie | **GitHub + Actions, changesets od startu**, nazwa `astroix` zajęta wcześnie, dogfood przez `bun link` *(pre-alpha pivota: git-based, bez publiku npm — amendement #188; warstwa publiku wycofywana w #192)* |
| Effect | **odrzucony** (uzasadnienie niżej) |

## Decyzje i uzasadnienia

1. **npm jako PM/runner, Node jako engine i shipped runtime.** *(Zmiana 2026-08-31, research #190, ratyfikacja #187 — pierwotnie bun z pinem w `packageManager`; overturn udokumentowany niżej.)* Ewidencja:

   - **bun odpada w całości.** Pin `bun@1.3.14` siedzi na martwej linii — 1.3.14 (2026-05-13) to ostatnie wydanie 1.3 ("rollback do 1.3" = zamrożenie na nieutrzymywanym branchu), a bun 1.4 to totalna przepiska Zig→Rust stable dopiero od 2026-08-19/20 — 11 dni w chwili researchu, z kontestowanym rollem-outem. To dokładnie klasa ryzyka, którą ta decyzja pre-flagowała od początku.
   - **pnpm: "not now" z fallback triggerem.** pnpm 12 = 1:1 przepiska silnika instalacji na Rusta (Pacquet), stable 2026-08-26 — 5 dni; `latest` wciąż na 11.24. Adoptowanie pnpm 12 na dzień 5 powtórzyłoby zakład bun-1.4. Fallback trigger (konkretny): ergonomia npm workspaces realnie zabolała (orchestration per-package, potrzeby izolacji) — wtedy target pnpm 11.24 albo przesiedziany pnpm 12, z kosztem drugiego toola i `node-linker=hoisted` pod Electrona.
   - **Zgodność z produktem**: supervisor na Node + pre-alpha dystrybuowana z gita (`npm install` i run) + endgame w Electron main → npm pozostaje naturalnym toolchainem obu kształtów dostawy (research #190 argumentował przez `npx`-pre-alpha z rulingu #184 — dystrybucję przestawił później amendement #188 na git-based; toolchain się przez to nie zmienia. Precedensy: Playwright i VS Code na npm; astro/vite/prisma na pnpm; żaden z badanych majorów nie rozwija się na bunie). Ten sam resolver/arborist w dev-tree, którego używają instalujący, zabija klasę dryfu "works in dev, breaks via npm" u korzenia.
   - **Monorepo pivota: npm workspaces** — członkowie app + core (legacy integration wypadł ze szkicu przez ruling #185); `e2e/fixture` zostaje standalone (publish-shaped staging `file:../../.astroix-local` jest celowo poza workspace'em). changesets+bun ma udokumentowane luki `workspace:*` przy publishu — kształt pivota to dokładnie miejsce, gdzie zaczęłyby gryźć; layout Electrona preferuje hoisted npm.
   - **Koszt zaakceptowany**: ~40–90 s na run CI i ~10–20 s na lokalną instalację (benchmarki 2026), mitygowane `cache: npm` na setup-node; buildy (tsup/vite/vitest/playwright) są PM-agnostyczne.
   - **Plan migracji (~1 skupiony dzień), zapisany tu jako plan — wykonanie = lane czarterowy #188, nie ten PR**: (1) lockfile: skasować `bun.lock`, `npm install` → `package-lock.json` (to samo w `e2e/fixture`); (2) skrypty `crap`/`crap:ci`/`preflight`/`ci:publish` na `node`/`npm`/`npx`, drop `packageManager`; (3) shebang `crap.mjs` na `#!/usr/bin/env node` — jedyny bun-only szew przenośny (Node 22.22+ robi type-stripping natywnie; verified); (4) pre-commit: `bunx` → `npx`/`node_modules/.bin`, help-texty; (5) 4 workflowy CI: setup-bun out, `npm ci` + `cache: npm`, `npm ci --prefix e2e/fixture`; (6) changesets bez zmian strukturalnych; (7) sweep dokumentów ~130 wspomnień bun w ~20 plikach (`CHANGELOG.md` = historia, nietknięty).

   Node 24 LTS w CI zostaje; engine floor `>=22.12` (wymóg Astro 7), nie "najnowszy Node" — engines nie służą do ścigania wersji.

2. **Jeden pakiet.** Core (indeks, splicer — czyste funkcje), node (integration: Vite plugin + middleware + watcher), client (chrome UI). Rozcięcie na workspaces dopiero przy drugim konsumentie (np. CLI). Monorepo od dnia 0 = podatek strukturą. *(Zmiana 2026-08-31, #190/#187: pivot JEST tym drugim konsumentem — własna reguła repo uruchamia workspaces. npm workspaces; członkowie app + core; legacy integration wypadła ze szkicu (#185 — `src/node` usuwa czarter #188); `e2e/fixture` zostaje standalone. Konkretny layout monorepo finalizuje czarter #188.)*

3. **Astro 7 only.** Filozofia: narzędzie do nowych projektów i ich maintenance. Zysk: jedna generacja zod (4) do introspekcji, jedno Vite API (8), zero macierzy testowej wstecz. Koszt: świadoma rezygnacja z hostów legacy — zaakceptowana.

4. **React 19 + Compiler.** Werdykt researchu: najniższe ryzyko, najgłębszy ekosystem. Decydujący argument produktowy: content tab to w pełni dynamiczny generator formularzy ze schem zod — React ma najgłębszy ekosystem formowy (TanStack Form + shadcn). Compiler 1.0 stable (od X 2025) usuwa ceremoniał memo/useCallback. Shadow DOM: `createRoot(shadowRoot)` to udokumentowany pattern; eventy delegowane przy korzeniu działają wewnątrz boundary; portale targetujemy do kontenera w shadow root. Bundle ~100–150 kB gzip — irrelewantne dla dev-only. Solid 2.0 odrzucony na faktach (RC framework, pre-1.0 Kobalte, beta solid-query v6). Svelte 5 pozostaje legalnym fallbackiem.

5. **Tailwind 4 + shadcn na Base UI.** StyleX odpada twardym faktem: maintainerzy StyleX odradzają shadow DOM ("inherently incompatible with atomic CSS"); dev-mode injection pisze do `document.head`, publicznego API dla shadow root brak, jedyna droga to nieudokumentowany hack na babel pluginie — a Astroix żyje w dev mode permanentnie. Do tego: pre-1.0, ekosystem "shadcn dla StyleX" w powijkach, agent-fluency 200–300x cieńszy niż TW+shadcn (a agentic-friendly to twarde kryterium). TW4 w shadow DOM — **zweryfikowany mechanizm zero-build** (wayfinder T1, issue #2): `@tailwindcss/vite@4.3.3` (peers `vite ^8`) wstrzyknięty `updateConfig` (guard gdy host już ma własny plugin TW), scope przez własny entry CSS chroma `@import "tailwindcss" source(none); @source "./"` (obowiązkowe — auto-detekcja omija node_modules), import entry z `?inline` i **jedna** constructed stylesheet adoptowana naraz na `document.adoptedStyleSheets` **i** `shadowRoot.adoptedStyleSheets` — dopiero wtedy `@property` działa w shadow tree (samo shadow traci, tailwindcss#15005); `:root`→`:host` rozwiązane upstream (v4 emituje `:root, :host` od beta-9). Dawne „osobny build chromu przez `adoptedStyleSheets`" martwy jako strategia buildu — `adoptedStyleSheets` zostaje jako zero-buildowy krok dostarczania. **Base UI jako warstwa primitives pod shadcn** (oficjalnie wspierana, 1.0 stable XII 2025, 35+ komponentów, wysokie momentum) — trzyma otwarte drzwi do najlepszego fragmentu świata StyleX. Motywy shadcn = szybkie składanie UI.

6. **TanStack wszędzie, gdzie się da** (durable preference właściciela). Form: dynamiczne field-arrays z walidacją zod-first to główna siła TanStack Form. Query: cache + deklaratywna invalidacja po custom eventach Vite WS (`astroix:*`). Router: **nie** — chrome to panel w shadow DOM, nie aplikacja nawigacyjna. zustand na czysto kliencki stan (selekcja, taby, tryby).

7. **fetch + custom eventy Vite WS, nie SSE i nie WebSocket własny.** Cała komunikacja chrome→middleware to request/response (fetch na Vite connect middleware); push watcher→chrome idzie kanałem, który już istnieje: `server.ws.send('astroix:…')` ↔ `import.meta.hot.on('astroix:…')` — działa, bo i chrome (przez `server.transformIndexHtml`) i strony hosta ładują `/@vite/client`; Astro samo shipuje tak `astro:content-changed` i `astro:routes-updated`. Watcher: **`server.watcher` hosta** — jeden subscriber FS w procesie, zero wyścigów z HMR, debounce reindex. Wymog twardy: selekcja elementu przeżywa reindex (re-match po zmianie plików → live update panelu reguł z IDE-zapisu).

8. **Vitest + happy-dom (unit), Playwright (prawda), Playwright MCP (interaktywnie).** Research "playwright-for-agents": żadne agentowe narzędzie dużego gracza nie zastępuje `@playwright/test` w CI (LLM w pętli każdego kroku = nondeterminizm). Pattern hybrydowy: CI = klasyczny Playwright; lokalnie = Playwright MCP (ten sam engine, `--caps=testing`) do debugowania i autoryzowania speców przez agenta (agent eksploruje przez MCP → pisze deterministyczny spec → CI odpala).

9. **Biome.** React (brak `.svelte`) odblokowuje Biome: jedno narzędzie, formatter+lint, TS-first, błyskawiczne — co przy workflow agentycznym (iteracje po każdej edycji) jest featą samą w sobie.

10. **Chrome: hybryda prebuilt/source (ADR-0001 — usunięty; sukcesja w ADR-0004).** *(Pivot 2026-08-31, #183/#187: hybryda wygasła — UI należy do aplikacji na originie supervisora; decyzja zostaje niżej jako zapis historyczny.)* Publikowana paczka shipuje **prebuilt bundel chroma** (pojedynczy ESM: react, Tailwind, CodeMirror w środku) ładowany przez wirtualny moduł — obcy host nigdy nie widzi source'u chroma i nigdy nie rozwiązuje naszego `react` (research T3: source-serving Reacta przez obcy Vite jest niebezpieczny — optymalizator kluczuje po gołym specyfikatorze, host podmienia kopię — i niepraktykowany przez żadne badane narzędzie). Nasz **dev-checkout** (dogfood przez `file:`) serwuje source chroma z wstrzykniętymi `@vitejs/plugin-react` (fast-refresh, `include`-scoped) i `@tailwindcss/vite` (mechanika T1) — kontrolowany host, goły `react` rozwiązuje się do naszego Reacta 19. React/react-dom jako **devDependencies** (bundlowane przy publikacji; konsument nigdy ich nie rozwiązuje). Budowa strony node bez zmian (tsup, ESM, peers external `astro`/`vite`). *(Zmiana 2026-08-26, wayfinder T4 — pierwotnie „chrome z source bez buildu".)*

11. **Effect: NIE.** Dwa niezależne powody: (a) v4 w RC (17 modułów "unstable", team: produkcja → v3, a v3 feature-frozen); (b) ważniejsze — kształt projektu jest zły dla Effect: ~90% kodu to czyste funkcje synchroniczne i UI; jedyny kandydat (orkiestracja watch→reindex→serve) to ~10% bazy w skali, gdzie zwykły async wystarcza. Trzeci, zgodny z kryterium agentic-friendly: modele piszą znakomity plain async/TS, idiomatyczny Effect — loteryjnie. Revisit tylko jeśli Astroix urośnie w pipeline-serwer. Typowane błędy w core: mały własny `Result`.

12. **CodeMirror 6** (markdown + raw CSS mode): modularny, framework-agnostic, bez webworkerowego ciężaru Monaco.

13. **`yaml` Document API** do frontmattera: edycja kluczy z zachowaniem komentarzy/kolejności/cytowania — spójne z filozofią splicera (diff = jedna linia, nie rozbity blok).

14. **GitHub + Actions + changesets + wczesne zajęcie nazwy.** Push: `biome check` → `tsc --noEmit` → `vitest run`. PR: + e2e (Playwright, Node 24). Zajęcie nazwy wykonane 2026-08-26 jako `@wojciechpiskorz/astroix@0.0.1`: unscoped `astroix` okazał się nie-rejestrowalny (npm name-similarity rule vs `astro`; "wolna nazwa" ≠ "rejestrowalna"); z dostępnych opcji (org `@astroix` vs scope osobisty) wybrano scope osobisty. Dogfood: fixture e2e (w repo) przez publish-shaped staging — dep `file:../../.astroix-local`, sync + build gate w `scripts/prepare-local-link.mjs`, CI buduje przed e2e — determinizm; `bun link` zarezerwowany dla zewnętrznego dogfoodu (osobny projekt, alphasy v0.1). *(Zmiana 2026-08-26, wayfinder charting — pierwotnie `bun link` do v0.1.)* *(Zmiana 2026-08-30, #123 — link publish-shaped: dep `file:../../.astroix-local`, staging sync + build gate w `scripts/prepare-local-link.mjs`; `file:../..` kopiował cały repo rekurencyjnie do node_modules.)* Changesets od startu. *(Zmiana 2026-08-31, amendement dystrybucyjny #188: pre-alpha aplikacji dystrybuowana z gita — clone/tag → `npm install`, bez publiku na npm; nazwa `@wojciechpiskorz/astroix` zostaje reserved-dormant, publik wraca jako config flip przy publicznym launchu; warstwa publiku (workflow, NPM_TOKEN, reguły changesetowe w PR) wycofywana w lane #192.)*

15. **AI PR review — TODO po v1, nie warunek POC.** Zaplanowane: `claude-code-action@v1` → endpoint Z.AI (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, klucz z GLM coding plan), advisory-only; fallback: PR-Agent (MIT, self-hosted) z `zai/glm-5.2`. Zasada z dużych repo 2026: AI nigdy nie blokuje merge'a — blokują gate'y deterministyczne.

## Odrzucone alternatywy (skrót)

- **Solid 2** — RC framework + pre-1.0 ecosystem + beta query: trzy ryzyka za dużo na produkt.
- **Svelte 5** — mocny, legalny fallback komfortu; nie realizował celu exploracji; przegrywa z ekosystemem formowym Reacta dla tego UI.
- **StyleX** — maintainer-discouraged w shadow DOM + pre-1.0 + słaba agent-fluency.
- **Effect v4** — RC + zły kształt projektu + anti-agentic.
- **WebSocket** — dwukierunkowość, której nie potrzebujemy.
- **jsdom** — happy-dom wygrywa throughputem; prawda o selectorach i tak w Playwright.
- **Monaco** — ciężar bez zysku dla raw-CSS boxa.
- **gray-matter/reprint frontmattera** — traci komentarze agenta.
- **Monorepo day-0, vite-in-vite day-0, PR-gate AI review day-0** — porządne, ale nie teraz.
