# Astroix — Stack

Pochodzenie: grilling stackowy 2026-08-26. Każda decyzja poparta faktem z researchów agentowych (sierpień 2026) albo bezpośrednim uzasadnieniem produktowym. Premisa: czysty stan, najlepszy stack do TEGO produktu. Zasada nadrzędna od researchu core-reuse: **jeśli core Astro/Vite już to ma, nie piszemy tego** — pełna inwentaryzacja w `docs/core-reuse.md` (m.in.: martwe SSE, martwy prebuild chroma, odczyt contentu przez `runner.import('astro:content')`, żywe CSS route'u z `virtual:astro:dev-css`).

---

## Podsumowanie jednym spojrzeniem

| Warstwa | Wybór |
| --- | --- |
| PM / runner | **bun** (lokalnie), pinned w `packageManager` |
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
| Build artefaktów | node: tsup-class (ESM, peers external) · **chrome: serwowany z source przez wirtualny moduł + pełny HMR — bez buildu klienta** |
| Publikowanie | **GitHub + Actions, changesets od startu**, nazwa `astroix` zajęta wcześnie, dogfood przez `bun link` |
| Effect | **odrzucony** (uzasadnienie niżej) |

## Decyzje i uzasadnienia

1. **bun jako PM/runner, Node jako engine floor.** Bun nie wycieka do konsumenta (lockfile się nie publikuje); `dist` jest agnostyczne. Ostrożność wobec świeżej bun 1.4 (przepiska na Rusta z 20.08.2026) — pin w `packageManager`, w razie problemów rollback do 1.3. CI na Node 24 LTS, żeby bramki deterministyczne nie zależały od najnowszego runtime'a PM-a. Engine floor `>=22.12` (wymóg Astro 7), nie "najnowszy Node" — engines nie służą do ścigania wersji.

2. **Jeden pakiet.** Core (indeks, splicer — czyste funkcje), node (integration: Vite plugin + middleware + watcher), client (chrome UI). Rozcięcie na workspaces dopiero przy drugim konsumentie (np. CLI). Monorepo od dnia 0 = podatek strukturą.

3. **Astro 7 only.** Filozofia: narzędzie do nowych projektów i ich maintenance. Zysk: jedna generacja zod (4) do introspekcji, jedno Vite API (8), zero macierzy testowej wstecz. Koszt: świadoma rezygnacja z hostów legacy — zaakceptowana.

4. **React 19 + Compiler.** Werdykt researchu: najniższe ryzyko, najgłębszy ekosystem. Decydujący argument produktowy: content tab to w pełni dynamiczny generator formularzy ze schem zod — React ma najgłębszy ekosystem formowy (TanStack Form + shadcn). Compiler 1.0 stable (od X 2025) usuwa ceremoniał memo/useCallback. Shadow DOM: `createRoot(shadowRoot)` to udokumentowany pattern; eventy delegowane przy korzeniu działają wewnątrz boundary; portale targetujemy do kontenera w shadow root. Bundle ~100–150 kB gzip — irrelewantne dla dev-only. Solid 2.0 odrzucony na faktach (RC framework, pre-1.0 Kobalte, beta solid-query v6). Svelte 5 pozostaje legalnym fallbackiem.

5. **Tailwind 4 + shadcn na Base UI.** StyleX odpada twardym faktem: maintainerzy StyleX odradzają shadow DOM ("inherently incompatible with atomic CSS"); dev-mode injection pisze do `document.head`, publicznego API dla shadow root brak, jedyna droga to nieudokumentowany hack na babel pluginie — a Astroix żyje w dev mode permanentnie. Do tego: pre-1.0, ekosystem "shadcn dla StyleX" w powijkach, agent-fluency 200–300x cieńszy niż TW+shadcn (a agentic-friendly to twarde kryterium). TW4 w shadow DOM ma znane quirki (`@property` nie działa w shadow root → rejestracja w hoście; `:root` → `:host`) z udokumentowanymi workaroundami — osobny build chroma wstrzykiwany przez `adoptedStyleSheets`. **Base UI jako warstwa primitives pod shadcn** (oficjalnie wspierana, 1.0 stable XII 2025, 35+ komponentów, wysokie momentum) — trzyma otwarte drzwi do najlepszego fragmentu świata StyleX. Motywy shadcn = szybkie składanie UI.

6. **TanStack wszędzie, gdzie się da** (durable preference właściciela). Form: dynamiczne field-arrays z walidacją zod-first to główna siła TanStack Form. Query: cache + deklaratywna invalidacja po custom eventach Vite WS (`astroix:*`). Router: **nie** — chrome to panel w shadow DOM, nie aplikacja nawigacyjna. zustand na czysto kliencki stan (selekcja, taby, tryby).

7. **fetch + custom eventy Vite WS, nie SSE i nie WebSocket własny.** Cała komunikacja chrome→middleware to request/response (fetch na Vite connect middleware); push watcher→chrome idzie kanałem, który już istnieje: `server.ws.send('astroix:…')` ↔ `import.meta.hot.on('astroix:…')` — działa, bo i chrome (przez `server.transformIndexHtml`) i strony hosta ładują `/@vite/client`; Astro samo shipuje tak `astro:content-changed` i `astro:routes-updated`. Watcher: **`server.watcher` hosta** — jeden subscriber FS w procesie, zero wyścigów z HMR, debounce reindex. Wymog twardy: selekcja elementu przeżywa reindex (re-match po zmianie plików → live update panelu reguł z IDE-zapisu).

8. **Vitest + happy-dom (unit), Playwright (prawda), Playwright MCP (interaktywnie).** Research "playwright-for-agents": żadne agentowe narzędzie dużego gracza nie zastępuje `@playwright/test` w CI (LLM w pętli każdego kroku = nondeterminizm). Pattern hybrydowy: CI = klasyczny Playwright; lokalnie = Playwright MCP (ten sam engine, `--caps=testing`) do debugowania i autoryzowania speców przez agenta (agent eksploruje przez MCP → pisze deterministyczny spec → CI odpala).

9. **Biome.** React (brak `.svelte`) odblokowuje Biome: jedno narzędzie, formatter+lint, TS-first, błyskawiczne — co przy workflow agentycznym (iteracje po każdej edycji) jest featą samą w sobie.

10. **Chrome z source przez Vite (aktualizacja po researchcie core-reuse).** Plan "prebuild + watch" dla klienta jest martwy: middleware zwraca HTML przez `server.transformIndexHtml` z referencją do wirtualnego modułu chroma (`resolveId`/`load`) — Vite serwuje React chroma z pełnym HMR bez żadnego buildu, za darmo działa fast-refresh (`@vitejs/plugin-react` przez `updateConfig`, scope `include` do plików chroma gdy host bez Reacta). Budowa zostaje tylko dla strony node (publikowany pakiet: ESM, peers external `astro`/`vite`). Dawne "vite-in-vite jako faza 2" stało się defaultem — oficjalnie wspieranym wzorcem.

11. **Effect: NIE.** Dwa niezależne powody: (a) v4 w RC (17 modułów "unstable", team: produkcja → v3, a v3 feature-frozen); (b) ważniejsze — kształt projektu jest zły dla Effect: ~90% kodu to czyste funkcje synchroniczne i UI; jedyny kandydat (orkiestracja watch→reindex→serve) to ~10% bazy w skali, gdzie zwykły async wystarcza. Trzeci, zgodny z kryterium agentic-friendly: modele piszą znakomity plain async/TS, idiomatyczny Effect — loteryjnie. Revisit tylko jeśli Astroix urośnie w pipeline-serwer. Typowane błędy w core: mały własny `Result`.

12. **CodeMirror 6** (markdown + raw CSS mode): modularny, framework-agnostic, bez webworkerowego ciężaru Monaco.

13. **`yaml` Document API** do frontmattera: edycja kluczy z zachowaniem komentarzy/kolejności/cytowania — spójne z filozofią splicera (diff = jedna linia, nie rozbity blok).

14. **GitHub + Actions + changesets + wczesne zajęcie nazwy.** Push: `biome check` → `tsc --noEmit` → `vitest run`. PR: + e2e (Playwright, Node 24). `astroix` wolna na npm (stanie na 2026-08-26) — zajmujemy jak najszybciej; dogfood przez `bun link` do v0.1, potem publiczne alphasy. Changesets od startu.

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
