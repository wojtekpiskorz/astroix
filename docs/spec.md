# Astroix — Spec

Status: ready-for-agent · Pochodzenie: sesja grilling 2026-08-26 (9 potwierdzonych decyzji) + grilling stackowy 2026-08-26 (patrz `docs/stack.md`) · Nazwa projektu: **Astroix**; pakiet npm: `@wojciechpiskorz/astroix` (unscoped `astroix` zablokowany przez npm name-similarity rule vs `astro` — decyzja 2026-08-26: scope osobisty)

Astroix = visual builder dla projektów Astro: dev-only integration z chrome (content + CSS) nad same-origin iframe canvas, oparta o repo-mapping stylów. Filozofia hostów: **najnowsze Astro — narzędzie do robienia nowych projektów i ich maintenance, nie do utrzymywania legacy** (peerDeps: `astro ^7`, `vite ^8`, zod 4; `engines >=22.12`).

---

## Problem Statement

Agent wykonuje dziś ~90% pracy nad projektami Astro, ale ostatnie 10% — poprawka treści ("zmień lead w hero") i doszlifowanie stylów ("to zdjęcie ma być mniejsze i zaokrąglone") — zmusza użytkownika do ręcznego grzebania w codebasie, którego może w ogóle nie znać: szukania właściwego pliku markdown, frontmattera, pliku CSS odpowiadającego konkretnemu elementowi na stronie. To odwraca proporcje: trivialna zmiana kosztuje więcej niż cała agentowa budowa sekcji.

Problem ma dwie twarze:

1. **Content**: treść stron i postów żyje we frontmatterze Content Collections — edycja bez GUI to ręczne YAML-owanie i zgadywanie pól.
2. **CSS**: style elementów są rozsiane po plikach `.css` i scoped `<style>` w `.astro` — nie ma mapy "element na ekranie → plik w repo".

## Solution

Dev-only integration do Astro. Po odpaleniu `astro dev` wejście przez `?builder=1` otwiera chrome buildera (sidebar w shadow DOM), w którym kanwa to same-origin iframe z żywą stroną. Dwie zakładki:

- **Content**: GUI nad Content Collections — formularze generowane automatycznie ze schem zod (custom fields = pola), body w edytorze markdown, jawny Save, walidacja inline nieblokująca zapisu.
- **CSS**: tryb zaznaczania na canwie. Klik w element → lista reguł z repo pasujących do niego, każda z plikiem i linią, z wskazaniem wygrywającej w kaskadzie → edycja inline (wiersze property→value z widgetami: kolor, jednostki, enumy; plus raw mode) → zapis text-splice do oryginalnego pliku źródłowego z auto-write debounce → HMR = live preview.

Kluczowa zasada: **repo-mapping, nie parallel world**. Builder czyta i pisze prawdziwe pliki repo tam, gdzie agent by je położył ("najbliższy dom"), więc repo pozostaje jednorodne, a agent pracuje obok bez świadomości istnienia buildera.

Synchronizacja dwukierunkowa (wymóg twardy): zapis w IDE → live update canvasu **i chroma** (podświetlony element i preview jego reguł odświeżają się same po reindex); zmiana w builderze → zapis do pliku lokalnego. Selekcja elementu przeżywa reindex.

## User Stories

1. Jako developer, chcę zainstalować Astroix jako pakiet w istniejącym projekcie Astro, tak aby nie przepisywać projektu pod narzędzie.
2. Jako developer, chcę aby `astro dev` z zainstalowanym Astroixem otwierał się od razu w wrapperze buildera (default-on), tak aby nie uczyć się osobnego URL-a ani panelu admina.
3. Jako developer, chcę dostać czystą, nietkniętą stronę przez `?builder=0` (lub odinstalowując Astroixa), tak aby ja i agent mogli pracować normalnie, bez side-effektów narzędzia.
4. Jako developer, chcę aby builder nie istniał w produkcyjnym buildzie, tak aby koszt na produkcji był zerowy.
5. Jako developer, chcę kanwę z prawdziwym viewportem (iframe), tak aby media queries i jednostki `vw` nie kłamały.
6. Jako developer, chcę tryb zaznaczania z hover outline, tak aby widzieć, co kliknę, zanim kliknę.
7. Jako developer, chcę móc wyłączyć tryb zaznaczania, tak aby normalnie klikać linki i interakcje na stronie.
8. Jako developer, chcę ostrzeżenie gdy selector elementu jest brittle (strukturalny), tak aby wiedzieć, że CSS może się oderwać po refactorze HTML.
9. Jako developer, chcę listę kolekcji i entry, tak aby znaleźć content do edycji bez znajomości ścieżek w repo.
10. Jako developer, chcę formularz generowany ze schemy zod, tak aby custom fields (np. `hero.title`, `hero.cta.href`) były polami, a nie YAML-em do odręcznej edycji.
11. Jako developer, chcę inline walidację zod przy polach, tak aby widzieć błąd przed zapisem.
12. Jako developer, chcę aby walidacja nie blokowała zapisu, tak aby móc zapisać draft łamiący schemę i zostawić poprawkę agentowi.
13. Jako developer, chcę edytor markdown z podglądem, tak aby poprawiać body bez otwierania IDE.
14. Jako developer, chcę jawny Save dla contentu, tak aby niezapisane zmiany nie lądowały na dysku przy każdym znaku.
15. Jako developer, chcę tworzyć nowe entry jako draft (przez flagę we frontmatterze), tak aby szkicować posty z poziomu GUI.
16. Jako developer, po kliknięciu elementu chcę listę reguł CSS pasujących do niego — każda z plikiem i linią — tak aby wiedzieć, GDZIE w repo żyją jego style.
17. Jako developer, chcę wskazanie, która reguła wygrywa w kaskadzie, tak aby nie edytować przegranej reguły i dziwić się brakowi efektu.
18. Jako developer, chcę widzieć reguły ze scoped style w `.astro` (z odfiltrowanym hashem `data-astro-cid-*`), tak aby scoped style nie były czarną magią.
19. Jako developer, chcę badge `@media` przy regułach w media queries, tak aby wiedzieć, że reguła działa warunkowo.
20. Jako developer, chcę edytować regułę w miejscu przez widgety (kolor, jednostki, enumy), tak aby podstawowe poprawki nie wymagały pisania z ręki.
21. Jako developer, chcę raw mode, tak aby móc pisać dowolny CSS, łącznie z ręcznym `@media`.
22. Jako developer, chcę aby edycja zapisywała się do oryginalnego pliku źródłowego z zachowaniem formatowania, tak aby git diff był minimalny, a agent czytał znany sobie świat.
23. Jako developer, chcę auto-write z debounce i podgląd na żywo przez HMR, tak aby skręcanie stylów było natychmiastowe, bez przycisku Save.
24. Jako developer, chcę undo w pamięci sesji, tak aby eksperymenty były odwracalne bez angażowania gita.
25. Jako developer, chcę aby nowa reguła lądowała w pliku stylów najbliższego przodka elementu ("najbliższy dom"), tak aby repo pozostało jednorodne z konwentem agenta.
26. Jako developer, chcę dropdown wyboru miejsca zapisu nowej reguły, tak aby móc świadomie wybrać plik, gdy heurystyka nie trafia.
27. Jako developer, gdy element nie ma żadnego domu w repo, chcę fallback do per-route overrides ładowany na końcu kaskady, tak aby zawsze było gdzie pisać.
28. Jako developer pracujący równolegle z agentem, chcę mtime/hash guard przed zapisem, tak aby builder nie nadpisał pliku zmienionego pod spodem — zamiast tego przeładował i pokazał diff.
29. Jako agent, chcę czytać pliki pisane przez Astroix jako zwykłe pliki repo, tak aby moja praca nie wymagała świadomości istnienia buildera.
30. Jako developer, chcę aby Astroix nigdy nie wykonywał operacji git, tak aby wersjonowanie było wyłącznie moją decyzją.
31. Jako developer, chcę chrome buildera w shadow DOM, tak aby style strony nie psuły UI buildera i odwrotnie.
32. Jako developer, chcę pracować na localhost bez warstwy auth, tak aby narzędzie dev nie wymagało setupu bezpieczeństwa.
33. Jako developer, chcę aby zapis pliku w IDE odświeżał live zarówno canvas, jak i otwarty panel reguł wybranego elementu, tak aby builder i IDE nigdy się nie rozjechały.
34. Jako developer, po kliknięciu elementu chcę zobaczyć, z jakiego pliku komponentu pochodzi (atrybuty `data-astro-source-*` dodawane przez dev mode Astro), tak aby nawigacja "element → źródło" była natychmiastowa, bez grepowania po repo.

## Implementation Decisions

1. **Form factor**: pakiet npm (`@wojciechpiskorz/astroix`) = Astro integration (Vite plugin + middleware), rejestrowany wyłącznie w trybie dev; produkcyjny build go nie zawiera. Host compat: `astro ^7`, `vite ^8`, zod 4, `engines >=22.12` — świadomie bez legacy.
2. **Wejście (default-on)**: z zainstalowanym Astroixem **każdy top-level URL w dev** renderuje chrome buildera; kanwa to same-origin iframe ładujący ten sam URL jako czystą stronę (`?builder=0`) — bezpośredni dostęp do `contentDocument`. **Escape hatch**: `?builder=0` na top-level URL zwraca nietkniętą stronę (dla człowieka, agenta, curla); nawigacja po stronie żyje wewnątrz canwy; tryb zaznaczania domyślnie wyłączony, włączany świadomie. Konfigurowalność trybu (opcje integracji w `astro.config` vs root `astroix.config.*`) — poza v1. *(Zmiana 2026-08-26, wayfinder charting: pierwotnie opt-in `?builder=1`; default-on wygrał jako naturalniejszy do testowania.)* Mechanika (core-first, patrz `docs/core-reuse.md`): chrome interceptuje Vite middleware zarejestrowany w **ciele** `configureServer` (pre-internal — dev handler Astro jest w post-hooku i nie woła `next()`), HTML przechodzi przez `server.transformIndexHtml` i referencje do **wirtualnego modułu chroma** — czyli chrome jest serwowany z source z pełnym HMR, bez prebuilda. Skrypt iframe'a (`?builder=0`): `injectScript` (guard `command === 'dev'`; per-URL filtracji brak — skrypt sam sprawdza query param). Dev toolbar Astro renderuje się na każdej stronie dev — w iframie chowamy go CSS-em z middleware; świadomie NIE wyłączamy `devToolbar.enabled` w configu, bo z tym ustawieniem wiąże się generowanie atrybutów `data-astro-source-*`, z których korzystamy (pkt 14).
3. **Kanwa = iframe** (nie div-wrapper): prawdziwy viewport (media queries działają), izolacja stylów, tanie przyszłe zoom / resize / mobile preview przez transform i szerokość wrapper-a. Chrome na stałe zabiera szerokość ekranu — zaakceptowane.
4. **Content v1**: wyłącznie Astro Content Collections (glob loader, schemy zod w content config). Odczyt przez core: `runner.import('astro:content')` (Environment API, jak samo Astro) — `getCollection()` zwraca **sparsowane** `entry.data`/`body`/`filePath`; schemy przez import `content.config` (`.collections`), introspekcja po `astro/zod` (wspólna instancja zoda z projektem). Formularz generowany z definicji schemy (zagnieżdżone obiekty → zagnieżdżone pola; `image()` → upload/picker — endpoint nasz, resolwcja metadanych darmowa). Zapis = pliki markdown z frontmatterem, serializacja przez Document API pakietu `yaml` (zachowuje komentarze, kolejność, styl cytowania). Źródła `.ts` data files i DB — poza v1.
5. **CSS indeks repo — hybryda**: statyczny skan źródeł projektu (`src/**`): globalne `.css` + bloki `<style>` z `.astro` (pozycje przez `extractStylesSync` z compiler-rs). Parser postcss (czysty CSS — bez SCSS, bez Tailwind emission). Indeks: selector → (plik, source range, media condition). To **prawda edycyjna** — dev mode nie generuje sourcemap CSS, a `is:inline` jest widoczne tylko w źródłach. Żywotność ("co realnie działa na podglądanym route'cie") i skompilowane formy scoped selectorów — z module graphu i wirtualnego modułu `virtual:astro:dev-css:{route}`.
6. **Matchowanie**: po kliknięciu, każdy selector z indeksu testowany na klikniętym elemencie przez `matches()` w kontekście dokumentu iframa; wyniki sortowane po specyficzności; wygrana reguła oznaczona; reguły w `@media` dostają badge warunku (warunek nie jest ewaluowany w v1). Selektory scoped (z hashem) rozpoznawane i prezentowane czytelnie.
7. **Edycja**: zmiany reguł to text-splice po source range z parsera — bez reprintu pliku, formatowanie i konwencje agenta nietknięte. UI reguły: wiersze property→value z inline-widgetami (color picker, stepper jednostek, dropdown enum) + toggle raw mode.
8. **Nowe reguły**: dom = plik zawierający style najbliższego przodka/rodzeństwa ("najbliższy dom"); dropdown z alternatywami jako escape hatch; fallback `src/styles/builder/[route].css` injectowany na końcu kaskady (wygrywa load orderem, bez `!important`). Nowych reguł nie piszemy do scoped bloków `.astro`; scoped style istniejące: czytane i edytowalne.
9. **Persistencja**: CSS — auto-write debounce (~300ms), bez przycisku Save, HMR jako podgląd; undo = historia w pamięci sesji. Content — jawny Save. Astroix nigdy nie wykonuje operacji git.
10. **Konflikt z agentem**: przed każdym zapisem weryfikacja mtime/hash pliku; przy zmianie pod spodem — przeładowanie i diff zamiast nadpisania.
11. **Izolacja UI**: chrome buildera renderowany w shadow DOM.
12. **Format stylów**: czysty CSS. W projektach z Tailwindem overrides po prostu ładują się po utility i wygrywają kaskadą — read-side będzie tam ubogi (spodziewane i OK).
13. **Sync dwukierunkny**: watcher hosta (`server.watcher`) jako jedyny subscriber FS → debounce reindex → push do chroma przez **custom eventy Vite WS** (`server.ws.send('astroix:…')` / `import.meta.hot.on`) — ten sam kanał, którego Astro używa dla własnych eventów; SSE niepotrzebne. Świeżość contentu: obserwacja pliku data store (sygnał post-sync core); tablica route'ów: hook `astro:routes:resolved` (re-runs przy zmianach route'ów). Operacje chrome→middleware to zwykłe requesty (fetch na Vite middleware). Selekcja elementu przeżywa reindex (re-match po zmianie plików).
14. **Instrumentacja źródeł = czytanie core Astro, nie własny transform**: w dev mode Astro dodaje do elementów atrybuty `data-astro-source-file` / `data-astro-source-loc` (mechanizm, na którym działa dev toolbar). v1 czyta je read-only — klik w element pokazuje plik/linię komponentu-źródła obok listy reguł. *(Uwaga T2, issue #3: na astro@7.2.7 + compiler-rs 0.4.0 `annotateSourceFile` jest stubem — atrybuty nie są emitowane; v1 potrzebuje mechanizmu własnego astroix lub zmiany strategii.)* Faza 2 ("nazwij ten element" → stabilne selectory) buduje na tym samym mechanizmie. Architektura (indeks + splicer) nie zmienia się przez to.

Stack, plumbing i narzędzia (React 19, Tailwind 4 + shadcn na Base UI, TanStack, bun, vitest, Playwright, Biome, changesets): **patrz `docs/stack.md`**. Pełna inwentaryzacja mechanizmów przejmowanych z core Astro/Vite (zamiast pisania własnych): **`docs/core-reuse.md`**.

## Testing Decisions

Dobra reguła: testujemy wyłącznie zachowanie zewnętrzne (wynikowe bajty plików, trafione reguły na fixture'ach), nigdy wewnętrzną strukturę indeksu.

Szwy (liczba celowo minimalna, dwa czyste moduły + jeden e2e):

1. **Indexer/Matcher** (czysty moduł): wejście — źródła CSS/astro jako stringi; wyjście — indeks selector→(plik, range, media); oraz funkcja match(indeks, element) → posortowane reguły. Testowalne bez Astro: fixture CSS + happy-dom. Kluczowe casy: scoped hashe, `@media` badge, sort po specyficzności.
2. **Splice-writer** (czysty moduł): (treść pliku, range, replacement) → nowa treść. Testy: zachowanie formatowania, edycje na brzegach range'u, append reguły na końcu pliku bez nowej linii.
3. **E2E seam**: syntetyczny projekt-fixture w repo (Astro 7, kolekcja ze schemą hero + co-located CSS) odpalany na prawdziwym dev serverze + Playwright — pełna pętla: `?builder=1`, klik element, edycja, asercja bajtów na dysku + reflect w iframe. Prawdę o selector engine mówi tylko prawdziwy Chrome (`[data-astro-cid-*]` — domyślna strategia `attribute`; `:where(...)` tylko po konfiguracji — weryfikacja T2, issue #3).

Wzorzec hybrydowy testów: `@playwright/test` w CI jako źródło prawdy; Playwright MCP lokalnie do interaktywnego debugowania i autoryzowania speców przez agenta (agent eksploruje przez MCP → pisze deterministyczny spec → CI go odpala).

## Out of Scope

- WYSIWYG, edycja blokowa, drag-drop layoutu
- SCSS; emission klas Tailwind; osobny panel wizualny Webflow-style
- Widgety breakpointów (raw `@media` ręcznie tylko); UI kaskadowych przekreśleń DevTools-style
- Resizable canvas, zoom, mobile preview (tanie później dzięki iframe, świadomie nie w v1)
- Element-naming przez instrumentację źródeł (faza 2)
- Content poza Content Collections (`.ts` data files, DB/CMS)
- Operacje git, auth (localhost dev only), jakiekolwiek działanie w produkcyjnym buildzie
- Wsparcie Astro < 7, Vite < 8, zod 3 (filozofia: nowe projekty, nie legacy)

## Further Notes

- **Fixture zamiast pilotów**: e2e żyje na syntetycznym projekcie w repo — stare projekty testowe nie są punktem odniesienia.
- **Ryzyka**: selektory scoped wymagają odfiltrowania hasha w UI; warunki `@media` nie są ewaluowane (badge tylko); w projektach Tailwind read-side naturalnie pusty (nowe reguły → fallback); quirki Tailwind 4 w shadow DOM (`@property`, `:root` vs `:host`) — rozwiązane mechanizmem zero-build z T1 (issue #2): jedna constructed stylesheet adoptowana na document + shadowRoot; `:root, :host` emitowane upstream.
- **TODO po v1 (nie blokuje POC)**: automatyczny AI review na PR — primary: `claude-code-action@v1` skierowany na endpoint Z.AI (`ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, klucz z GLM coding plan), advisory-only; fallback: PR-Agent z `zai/glm-5.2`. Required gates pozostają deterministyczne (biome → tsc → vitest → e2e).
- **Provenance decyzji**: 9 decyzji produktowych (grilling #1, 2026-08-26) + decyzje stackowe (grilling #2, 2026-08-26, z researchami: frameworki/Effect/bun, agent browser automation, StyleX/Base UI, AI PR review) + research core-reuse (2026-08-26, 3 researchy: content APIs, CSS/compiler, integration surface — wyniki w `docs/core-reuse.md`).
- **Tracker**: GitHub Issues (mapa wayfindera + tickety decyzyjne). Ten plik pozostaje **specem of record** — plik > issue dla dokumentu produktu; decyzje POC żyją na mapie (`wayfinder:map`). *(Zmiana 2026-08-26, wayfinder charting — pierwotna notatka zakładała migrację specu do trackera.)*
- **POC**: zakres i decyzje — mapa wayfindera (GitHub Issues, label `wayfinder:map`); POC = pion v0 z pełnymi bramkami jakości (nie spike).
