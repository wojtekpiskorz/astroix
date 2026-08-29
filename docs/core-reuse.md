# Astroix — Core Reuse Map

Pochodzenie: trzy researchy agentowe (26.08.2026), zweryfikowane przeciw `withastro/astro@main` (Astro 7.2, Vite 8/Rolldown, zod 4.3) i docs.astro.build/vite.dev. Zasada: **jeśli core Astro/Vite już to robi — nie piszemy tego**. Statusy: ✅ core (używamy wprost) · 🟡 częściowo (core pomaga, reszta nasza) · 🔨 sami (brak odpowiednika).

## 1. Chrome: serwowanie i HMR

- ✅ **Intercept `?builder=1` na każdym route (w tym 404)**: Vite plugin zarejestrowany w `astro:config:setup` przez `updateConfig({vite:{plugins:[…]}})`, middleware dodany w **ciele** `configureServer` (nie w post-hooku). Uzasadnienie ze źródeł: Astro rejestruje swój `astroDevHandler` w post-hooku i **nigdy nie woła `next()`** — tylko pre-internal middleware łapie wszystko. (`vite-plugin-astro-server/plugin.ts`)
- 🟡 **Chrome przez wirtualny moduł — hybryda prebuilt/source (ADR-0001)**: middleware zwraca HTML wołający `server.transformIndexHtml(url, rawHtml)` (dostajemy zastrzyk `/@vite/client` + react-preamble) i referencję do **wirtualnego modułu** `/virtual:astroix/chrome` (kanoniczne `resolveId`/`load`). Kolejne requesty modułowe obsługuje Vite niezależnie od tego, kto wyprodukował HTML (oficjalny analog: Vite Backend Integration guide). W **dev-checkout**: source chroma + fast-refresh przez `@vitejs/plugin-react` (v6, Oxc, `include`-scoped) i `@tailwindcss/vite` (T1). W **publikowanej paczce**: prebuilt bundel chroma — obcy host nie widzi source'u ani nie rozwiązuje naszego `react` (T3: niebezpieczne i niepraktykowane).
- ✅ **Skrypt w iframe (`?builder=0`)**: `injectScript(stage, code)` w `config:setup` (haczyk: działa też na build — guard `if (command === 'dev')`; brak filtrowania per-route/query — skrypt sam sprawdza `location.search`). Stage `page` = moduł przetwarzany przez Vite.
- ⚠️ `transformIndexHtml` (plugin hook) **nie działa** dla stron Astro (one nie przechodzą przez HTML middleware Vite) — tylko API `server.transformIndexHtml` w naszym middleware.

## 2. Transport i eventy

- ✅ **Push watcher→chrome przez custom eventy Vite WS** (SSE odpada): `server.ws.send('astroix:…', payload)` / per-klient `client.send()`; klient: `import.meta.hot.on('astroix:…')`. Działa, bo i chrome (`transformIndexHtml`) i strony hosta (`headElements`) ładują `/@vite/client`. Astro samo tak shipuje `astro:routes-updated`, `astro:content-changed`. Kierunek odwrotny (klient→server): `import.meta.hot.send` / `server.hot.on` — typowanie przez `CustomEventMap`.
- 🔨 **`full-reload` tarczy chroma — szew na `server.ws.send`** (#74): sync contentu Astro broadcastuje vite'owy `full-reload` do **każdej** podłączonej strony — także do chroma, którego sesja w pamięci (tab, active entry, brudny draft) zginęłaby przy każdej pauzie zapisu. Core nie daje mechanizmu osłonienia jednego klienta, więc `chrome-reload-shield.ts` patchuje `send` na wraperze WS (`server.ws` === `environments.client.hot`): ogłoszeni przez custom event klienci-chrome są pomijani przy full-reload, reszta (kanwa, taby host-developera) dostaje stockowe zachowanie. **Szew internals**: wraper przyjmuje i payload-obiekt, i formę `(event, data)`; wysyłka tylko do socketów `readyState === 1` (throw na martwym gniecie pipeline sync Astro). Upgrade vite'a, który przestawi ten seam, degraduje do stockowego zachowania (chrome się przeładowuje) — zdiagnozowane od doksa, nie od bisectu.
- ✅ **CRUD przez Vite connect middleware** (nie Astro app middleware — `addMiddleware` to pipeline aplikacji z `locals`, dev i prod). SSE też by działał, ale WS mamy za darmo. Wzorzec z core: `/_astro/status` (`vite-plugin-dev-status`).
- ✅ **Watcher**: `server.watcher` (chokidar) — `addWatchFile` tylko dla plików restartujących dev server (ciężkie).

## 3. Content

- ✅ **Odczyt kolekcji z middleware**: `createServerModuleRunner(server.environments.ssr)` → `runner.import('astro:content')` → `getCollection()` zwraca entry z **sparsowanym** `entry.data` (frontmatter→obiekt), `entry.body`, `entry.filePath`. Tak samo robi core (`content/utils.ts`). `ssrLoadModule` w Vite 8 jest na liście przyszłych usunięć — nie używać. Haczyk: nie cachować modułu między requestami (core czyści cache po invalidacji).
- ✅ **Schemy kolekcji**: `runner.import(contentConfigPath)` → `.collections: Record<string, {schema?, loader?, type?}>`; schema może być funkcją `({image}) => …` — wywołujemy z własnym stubem `image()`. Subskrypcja zmian configu: `globalContentConfigObserver` (`@internal`).
- ✅ **`astro/zod` = re-export `zod/v4`** — ta sama instancja zoda co projekt: introspekcja przez `.def.*` bez piekła instanceof; do generowania formularzy pomaga `z.toJSONSchema()` (zod 4).
- ✅ **Świeżość contentu**: obserwować **plik data store** przez `server.watcher` — to dokładnie sygnał "content zsynchronizowany", którego sam core używa (post-sync, bez wyścigów z loaderem). Core wysyła też `astro:content-changed` przez WS.
- 🔨 **Zapis entry**: core tylko parsuje. Serializer (yaml Document API + reguły slugów mirroringiem `generateIdDefault` z `glob.ts`) i **upload endpoint dla `image()`** — nasze. Odczyt pól obrazkowych darmowy: `entry.data.hero` = `{src, width, height, format}` (dev serwuje przez `/@fs/`).
- ✅ Preview body: `render(entry)` z core. Bonus: `experimental.contentIntellisense` wystawia manifest kolekcji (`.astro/collections/`).

## 4. CSS: indeks, scoped, splicing

- ✅ **Żywe CSS route'u**: wirtualny moduł **`virtual:astro:dev-css:{route-component}`** — eksport `css` = Set `{id, url, content}` dokładnie tych stylów, które Astro wstrzykuje stronie w dev. Scoped `<style>` to prawdziwy moduł CSS: id `{file}.astro?astro&type=style&index={N}` — obcięcie query = mapowanie na plik `.astro`. Spacer po grafie: per-environment `environment.moduleGraph` (mixowany `server.moduleGraph` w Vite 8 deprecated), referencja `collectCSSWithOrder` z core (~60 linii).
- ✅ **Hash scoped**: `data-astro-cid-*` = Rust `DefaultHasher` (SipHash-1-3) + własne kodowanie base32-podobne na znormalizowanej nazwie pliku (compiler-rs; xxhash64 to był Go-compiler), stabilny między przeładowaniami; compiler zwraca go w `TransformResult.scope` — nie liczymy. Domyślny `scopedStyleStrategy: "attribute"` emituje gołe `[data-astro-cid-*]`; tryb `:where(...)` dopiero po konfiguracji. *(Zweryfikowano na astro@7.2.7 — wayfinder T2, issue #3.)* Pisanie scoped reguł (faza 2): `transform()` na syntetycznym wrapperze albo ręcznie `:where([data-astro-cid-{scope}])`.
- ✅ **Pozycje bloków `<style>` dla splicera**: `extractStylesSync(source) → StyleBlock[]` — eksport z **`@astrojs/compiler-binding`** (warstwa napi; `@astrojs/compiler-rs` to façade — kanoniczny dla Astro 7; Go/WASM `@astrojs/compiler` też żyje). *(Zweryfikowano na astro@7.2.7 — wayfinder T2, issue #3.)* Offset przez `source.indexOf(block.content)` (technika z `enhanceCSSError` core). Pułapki: pozycje z `parse()` "incomplete", `metaRanges` z `convertToTSX` w przestrzeni TSX — **nigdy nie splicować z nich**.
- 🔨 **Statyczny indeks źródeł (prawda edycyjna) — nasz**: dev nie generuje sourcemap CSS (`css.devSourcemap` nigdy nie ustawiane), więc mapowanie reguła→(plik, range) robimy własnym postcss po plikach źródłowych. To jedyny sposób na splicing + jedyny, który widzi `is:inline` (niewidoczne w module graph).
- 🟡 **Architektura hybrydowa**: statyczny indeks (edycja: plik+range) **×** module graph (żywotność + skompilowane formy scoped selectorów do matchowania `el.matches`).

## 5. Routes, toolbar, misc

- ✅ **Tablica route'ów**: hook **`astro:routes:resolved`** → `IntegrationResolvedRoute[]` (`pattern`, `entrypoint`, `params`, `generate()`, typ) — w dev **re-runs przy każdej zmianie plików route'ów** (idealne pod reindex + nazewnictwo overrides + kojarzenie route↔entry). Runtime: `virtual:astro:routes`, event `astro:routes-updated`.
- 🟡 **Element→źródło**: brama istnieje (`devToolbar.enabled` ⇄ atrybuty), ale na zablokowanym stacku (astro@7.2.7 + compiler-rs 0.4.0) `annotateSourceFile` to **stub** — `data-astro-source-*` nie jest emitowane wcale; user story 34 (v1) wymaga mechanizmu własnego astroix albo zmiany strategii. *(Zmiana statusu: wayfinder T2, issue #3.)* Dev toolbar chowamy w iframie CSS-em; **nie** wyłączamy `devToolbar.enabled` przez `updateConfig` (działa, ale giną atrybuty; ginie też transport toolbarowy — którego i tak nie używamy).
- 🟡 **Container API** (`experimental_AstroContainer`): nadal eksperymentalne — tylko przyszłość (podgląd komponentu w izolacji).
- ✅ Dev-tooling okolice: `astro dev --background` + `stop/status/logs`, `/_astro/status`, structured logging (`--json`) — przydadzą się do orkiestracji w e2e i dla agentów.

## Co w efekcie umiera z naszych planów

| Plan | Los |
| --- | --- |
| Prebuild chroma + watch (stack #10) | **martwe** — chrome z source przez wirtualny moduł, HMR gratis |
| SSE (stack #7, spec #13) | **martwe** — custom eventy Vite WS (`astroix:*`) |
| Własna warstwa skanowania/parsowania contentu | **martwa** — `runner.import('astro:content')` |
| Własne watchowanie .md | **martwe** — obserwacja data store + `astro:content-changed` |
| Własny wykrywacz "jakie CSS żyją na stronie" | **martwy** — `virtual:astro:dev-css` + module graph |
| Statyczny indeks postcss + splicer | **zostaje** (prawda edycyjna; sourcemapy w dev nie istnieją; `is:inline`) |
| Walker zod → formularze | **zostaje** (łatwiejszy: `astro/zod` wspólne, `z.toJSONSchema()`) |
| Serializer wpisów + upload obrazków | **zostaje** (core tylko parsuje) |
| tsup na stronę node (integration) | **zostaje** — to publikowany pakiet |

Sources (główne): docs.astro.build (integrations reference, container reference), vite.dev (api-plugin, api-hmr, api-javascript, backend-integration, changes/per-environment-apis, changes/ssr-using-modulerunner, announcing-vite8), github.com/withastro/astro (vite-plugin-astro-server/plugin.ts, vite-plugin-dev-status, vite-plugin-app/environment.ts, createAstroServerApp.ts, vite-plugin-css/index.ts, content/*, integrations/hooks.ts, issues #13885), github.com/withastro/compiler + compiler-rs. Pełne listy URL w transkryptach researchów (26.08.2026).
