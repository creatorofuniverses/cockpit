# Пространство «Раннеры», этап «Сейчас» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** новое пространство кокпита «Runners», только для просмотра. Показывает, что сейчас происходит с облачными CI-раннерами,
по выводу `ci-runners status --json --offline`.

**Architecture:** точная копия устройства пространства `aq`. Крейт `herdr/tui/runners` (`model.rs` превращает JSON сервиса
в модель вида, `gui.rs` находит бинарник, проверяет `version --json`, вызывает `status` и раз в 20 с будит вид). Вид
`runners` регистрируется в `cli/src/gui.rs`. В моде `app/mods/cockpit/runners.js` рисует экран, а сайдбар, Home, клавиши
и раскладки подключают его так же, как `aq`.

**Tech Stack:** Rust (workspace `herdr/tui`, `serde_json`, `chrono`, `insta`), ES-модули мода на `gpui-kit`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-22-runners-space-design.md`

## Global Constraints

- Кокпит ничего не считает за сервис: ни порогов, ни правил уборщика, ни денег. Модель только переводит поля сервиса
  в слова и минуты.
- Ни одного вызова, который ходит в сеть: только `ci-runners version --json` и `ci-runners status --json --offline`. Команда,
  которой нет в `features`, не вызывается никогда.
- Проблемы приходят только из `warnings` сервиса. «tick стоит» — это предупреждение с `kind == "tick-stale"`, своего
  порога у кокпита нет.
- Неизвестная `v` в ответе `status` → состояние `newer` («update cockpit»), ничего не рисуется наугад. Неизвестные поля
  пропускаются.
- Только просмотр: в этом плане нет действий (`act` → `None`), нет кнопок, нет подтверждений.
- Фикстуры, снимки и скриншоты только вымышленные, в духе мира acme: серверы `sel-ci-demo1`, `sel-ci-demo2`,
  `sel-img-demo`, ID вида `00000000-0000-4000-8000-00000000000N`, флейвор `SL1.8-16384-128`. Никаких настоящих ID,
  имён и проекта Selectel пользователя.
- Тексты интерфейса — по-английски, как во всём кокпите. Суммы в рублях всегда с «≈» и словом «estimate».
- Правила `AGENTS.md`: doc-комментарии в одно-два предложения в настоящем времени. Rust ≈160 колонок, `cargo fmt` по
  `herdr/tui/rustfmt.toml`. Rust-тесты запускать как `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE HC_BIN=/nonexistent/hc cargo test …`.
  Полные прогоны идут через aq.
- Форма JSON в фикстурах — черновик из спеки. Когда сервис пришлёт путь к своей зафиксированной спеке формы (обещано
  в amail #257), фикстуры и разбор подстраиваются под неё до финального ревью ветки.
- Работа идёт в ветке от `main` форка (`fork/main`). Коммиты разрешены по задачам плана. Push, merge в `main` и
  `just desk-server` делаются только по просьбе пользователя.

## Review Focus

1. **`ci-runners` есть, но старый: нет `version --json` или в `features` нет `status-offline`.** Ожидается карточка
   «update ci-runners», а `status` при этом не вызывается вовсе. Тест в задаче 2.
2. **`tick` встал, а файлы не меняются.** Опрос раз в 20 с пересобирает вид, сервис отдаёт `tick-stale`, и данные
   помечаются как устаревшие, а не исчезают. Тесты в задачах 1 и 2.
3. **Опрос очереди выключен (`queue: null`) или устарел.** Плитка «Queued» не показывается, а при устаревшем значении
   стоит пометка «as of Nm ago». Тесты в задачах 1 и 3.
4. **Сервис зависает или печатает не-JSON.** Ожидается состояние `down` с первой строкой stderr или текстом про
   таймаут, хаб не блокируется дольше 5 с. Тест в задаче 2.
5. **Машина без ci-runners.** Ни иконки, ни строки на Home, и каталог `~/.local/state/ci-runners` не создаётся.
   Тесты в задачах 2 и 4.

---

## Модель вида (контракт хаб → мод)

Его производит задача 1, потребляют задачи 3 и 4.

```jsonc
{
  "state": "absent" | "outdated" | "newer" | "no-tick" | "down" | "live",
  "error": "…" | null,                       // down / outdated / newer: why, for a person
  "line":  {"text": "2 servers · 1 busy · 3 queued", "tone": "warning" | null} | null,   // null only when absent
  "badge": {"count": 2 | "!", "tone": "warning"} | null,
  "tick":  {"ago": "1m", "ok": true, "errors": 0, "stale": false} | null,
  "warnings": [{"kind": "tick-stale", "text": "no successful tick for > 5 min", "object": null}],
  "tiles": {"servers": 3, "runners": 2, "busy": 1, "queued": 3 | null, "queue_ago": "4m" | null, "cost": "≈ 53 ₽" | null},
  "servers": [{
    "id": "…", "name": "sel-ci-demo2", "role": "runner" | "image-builder", "status": "ACTIVE", "drain": false,
    "phase": "busy" | "idle" | "booting" | "draining" | "building" | "other",
    "age": "8m", "flavor": "SL1.8-16384-128", "size": "8 vCPU · 16 GiB · 128 GB", "image": "…", "trial_label": null,
    "runner": {"name": "sel-ci-demo2-1", "online": true, "busy": false, "idle": "6m" | null} | null,
    "next": {"text": "delete in 9m · idle", "at": "…"} | null,
    "cost": "≈ 4 ₽" | null,
    "warned": false                            // some warning's object is this server's id
  }]
}
```

Правила (единственная «логика» кокпита, и вся она про отображение):
- `phase`: `drain` → `draining`. Иначе роль `image-builder` → `building`. Иначе раннер `busy` → `busy`, раннер `online`
  → `idle`, раннера нет или он не `online` при статусе `ACTIVE` → `booting`. Всё остальное → `other`.
- `line.text` при `live`: `"N servers · B busy"`, к нему `" · Q queued"`, если `queued` не `null`. Без серверов —
  `"no servers"`. `tone` = `"warning"`, если `warnings` не пуст. Не-`live` состояния дают тексты `"update ci-runners"`,
  `"update cockpit"`, `"tick has not run"`, `"ci-runners does not answer"`, все с `tone: "warning"`.
- `badge`: при `live` с предупреждениями → `{count: warnings.len(), tone: "warning"}`. При `outdated`, `newer`,
  `no-tick` и `down` → `{count: "!", tone: "warning"}`. В остальных случаях `null`.
- `no-tick`: `tick.installed == false` или `tick.last_at == null`.
- Все промежутки времени считаются от начала текущей минуты (как `aq`, `model.rs:242`) и пишутся так же, как `span`
  в `aq` (`"8m"`, `"1h 12m"`), чтобы модель менялась раз в минуту, а не на каждом опросе.
- `cost`: `"≈ {round} ₽"` из `cost_estimate_rub`, `null` → `null`. Плитка `tiles.cost` — сумма по серверам, у которых
  она есть. Если хоть у одного сервера `null`, то `null`: часть суммы показывать нельзя.
- `next.text`: `"{action} in {span(at − now)} · {reason}"`. Если `at` в прошлом — `"{action} now · {reason}"`.
- Если `state_dir` из ответа не совпадает с каталогом, за которым следит хаб, в `warnings` добавляется
  `{kind: "state-dir", text: "ci-runners keeps its state in {state_dir}; cockpit watches {watched}, so it updates every 20 s", object: null}`.

---

### Task 1: модель вида (`cockpit-runners`, `model.rs`)

**Files:**
- Create: `herdr/tui/runners/Cargo.toml` (как `aq/Cargo.toml`: `cockpit-core`, `chrono`, `serde_json`; dev — `insta`, `tempfile = "3"`)
- Create: `herdr/tui/runners/src/lib.rs` (`pub mod gui; pub mod model;`, doc-комментарий в стиле `aq/src/lib.rs`)
- Create: `herdr/tui/runners/src/model.rs`
- Create: `herdr/tui/runners/tests/fixtures/status-live.json` — три сервера: `sel-ci-demo1` (раннер занят),
  `sel-ci-demo2` (простой 6 мин, `next` = delete/idle через 9 мин), `sel-img-demo` (image-builder). `queue.queued_runs = 3`,
  одно предупреждение `idle-long` с `object` = ID `sel-ci-demo2`. Формат — пример `status --json` из спеки.
- Create: `herdr/tui/runners/tests/fixtures/version.json` — `{"version": "0.0.0-demo", "json_v": 1, "features": ["status-offline"]}`
- Modify: `herdr/tui/Cargo.toml:4` — добавить `"runners"` в `members` (перед `"cli"`), и `cockpit-runners` в
  `[workspace.dependencies]`, если `cockpit-aq` там есть.

**Interfaces:**
- Produces:
  - `pub enum Source { Absent, Outdated(String), Down(String), Live(Value) }`
  - `pub fn model(source: Source, watched: &Path, now: DateTime<Utc>) -> Value` — контракт выше.
  - `pub const JSON_V: u64 = 1;`

- [ ] **Step 1: Write the failing tests** (`#[cfg(test)] mod tests` в `model.rs`, фикстуры читаются через `include_str!`)
  - `the_live_status_becomes_tiles_rows_and_a_line`: `insta::assert_json_snapshot!` модели `status-live.json` при `now`
    = `last_at` + 40 с. Снимок потом читает тест мода в задаче 3.
  - `phase_follows_drain_role_and_runner`: пять маленьких серверов дают `draining`, `building`, `busy`, `idle`, `booting`.
  - `absent_hides_and_the_rest_warn`: `Absent` → `line == null && badge == null`. `Outdated`/`Down` → `state`, `error`,
    `badge.count == "!"`.
  - `an_unknown_v_reads_newer`: `v: 2` → `state == "newer"`, `servers` нет.
  - `no_tick_when_never_ran`: `tick.installed: false` → `no-tick`. `tick.last_at: null` → `no-tick`.
  - `tick_stale_is_the_service_s_word`: `warnings` с `tick-stale` → `tick.stale == true`, `servers` на месте. Без него
    `last_at` час назад даёт `tick.stale == false`.
  - `queue_off_hides_the_tile`: `queue: null` → `tiles.queued == null`, в `line.text` нет «queued».
  - `cost_sums_only_when_every_server_has_one`: один `cost_estimate_rub: null` → `tiles.cost == null`.
  - `times_move_once_a_minute`: модели при `now` и `now + 20 s` внутри одной минуты равны.
  - `a_different_state_dir_warns`: `state_dir` ≠ `watched` → предупреждение `state-dir`.
- [ ] **Step 2:** `cd herdr/tui && env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE HC_BIN=/nonexistent/hc cargo test -p cockpit-runners` — FAIL (нет `model`).
- [ ] **Step 3:** реализовать `model()` по правилам из раздела «Модель вида». Помощники `since`/`span` взять по образцу
  `aq/src/model.rs`, не импортируя крейт `aq`.
- [ ] **Step 4:** тот же запуск — PASS. Принять снимок: `cargo insta accept -p cockpit-runners`, просмотреть его глазами.
- [ ] **Step 5:** `cargo fmt` и `cargo clippy -p cockpit-runners --all-targets --locked -- -D warnings` чисты. Commit
  `runners: the view model from ci-runners status --json`.

### Task 2: источник данных и регистрация вида (`gui.rs`, `cli`, `go.rs`)

**Files:**
- Create: `herdr/tui/runners/src/gui.rs`
- Modify: `herdr/tui/cli/Cargo.toml` (рядом с `cockpit-aq` на строке 20) — `cockpit-runners = { path = "../runners" }`
- Modify: `herdr/tui/cli/src/gui.rs:113-118` — зарегистрировать `Def { name: "runners", docs: &[], dirs: cockpit_runners::gui::dirs, build: cockpit_runners::gui::view, act: |_, _| None }`
  и `cockpit_runners::gui::start(|| views::touch("runners"))`.
- Modify: `herdr/tui/hub/src/go.rs:22` — `"runners" => Some("runners")`.

**Interfaces:**
- Consumes: `model::{Source, model}` (задача 1); `cockpit_core::run::output(cmd, limit, cap, &Default::default())`
  (`core/src/run.rs:90`); `cockpit_core::files::home()`.
- Produces:
  - `pub fn state_dir() -> PathBuf` → `home()/.local/state/ci-runners` (так `tick.DefaultDir` сервиса, `XDG_STATE_HOME` не читается).
  - `pub fn dirs() -> Vec<PathBuf>` → `vec![state_dir()]`, только если `bin()` нашёл бинарник, иначе пусто.
    Хаб создаёт отслеживаемые каталоги, а на машине без ci-runners создавать их нельзя.
  - `pub fn view(args: &Value, doc: &dyn Fn(&str) -> Value) -> Value` → `model(source(bin()), &state_dir(), Utc::now())`.
  - `pub fn start(touch: fn())` — поток, который раз в 20 с вызывает `touch`, запускается один раз (как `aq/src/gui.rs:165`).
  - `fn bin() -> Option<PathBuf>`: `CI_RUNNERS_BIN` (непустой и исполняемый), иначе `ci-runners` в `PATH`, иначе
    `~/.local/bin/ci-runners`.
  - `fn source(bin: Option<PathBuf>) -> Source`: нет бинарника → `Absent`. `features(&bin)` без `status-offline` →
    `Outdated("ci-runners on this machine has no status --json --offline; update it")`. Иначе
    `status --json --offline` с лимитом 5 с и потолком 1 МиБ. Ненулевой код → `Down(первая непустая строка stderr или "ci-runners status exited N")`.
    Не-JSON → `Down("ci-runners status printed no JSON: …")`. Таймаут → `Down("ci-runners status did not answer within 5s")`.
  - `fn features(bin: &Path) -> Result<Vec<String>, String>`: `version --json` с лимитом 5 с. Результат кэшируется
    в `OnceLock<Mutex<HashMap<(PathBuf, SystemTime), …>>>` по пути и `mtime` бинарника, так что после обновления
    ci-runners он перечитывается сам. Ненулевой код или не-JSON → `Ok(vec![])`, то есть старая версия.

- [ ] **Step 1: Write the failing tests** (`#[cfg(test)]` в `gui.rs`; поддельный бинарник — `sh`-скрипт в `tempfile::tempdir()`,
  он печатает фикстуры из задачи 1 и пишет в файл-счётчик каждый свой вызов; переменные окружения тесты не трогают)
  - `no_binary_is_absent`: `source(None)` → `Absent`.
  - `an_old_binary_is_outdated_and_status_is_never_called`: скрипт на `version` выходит с кодом 1 → `Outdated`, в
    счётчике нет ни одного вызова `status`.
  - `a_binary_without_status_offline_is_outdated`: `features: []` → `Outdated`, `status` не вызывался.
  - `a_live_binary_gives_its_status`: → `Live`, и `model(...)["state"] == "live"`.
  - `a_failing_status_is_down_with_its_stderr`: `status` пишет `boom` в stderr и выходит с кодом 3 → `Down("boom")`.
  - `garbage_is_down`: `status` печатает `not json` → `Down`, текст начинается с `"ci-runners status printed no JSON"`.
  - `a_hanging_status_is_down_within_the_limit`: `status` делает `sleep 30`. `source` возвращается меньше чем за 7 с
    с `Down`, текст содержит `"did not answer"`.
  - `features_are_read_once_per_binary_version`: два вызова `source` → один вызов `version`. Если сменить `mtime`
    скрипта, будет второй вызов.
- [ ] **Step 2:** `cargo test -p cockpit-runners` (с переменными из Global Constraints) — FAIL.
- [ ] **Step 3:** реализовать функции из Interfaces и подключить регистрацию в `cli/src/gui.rs` и `go.rs`.
- [ ] **Step 4:** `cargo test -p cockpit-runners -p cockpit-hub go::` — PASS. `cargo build -p cockpit` собирается.
- [ ] **Step 5:** fmt и clippy (`-p cockpit-runners -p cockpit -p cockpit-hub`) чисты. Commit
  `runners: read ci-runners status offline, register the view`.

### Task 3: экран `runners.js`

**Files:**
- Create: `app/mods/cockpit/runners.js`
- Modify: `app/mods/cockpit/main.js:33,46` — `import Runners from "./runners.js"`, `runners: Runners` в `VIEWS`.
- Test: `app/tests/runners.test.mjs` (загрузчик модулей скопировать из `app/tests/aq.test.mjs:1-62`; модель брать из снимка
  `herdr/tui/runners/src/snapshots/cockpit_runners__model__tests__the_live_status_becomes_tiles_rows_and_a_line.snap`)

**Interfaces:**
- Consumes: модель вида (задача 1) через `hub.subscribe(cx, { views: ["runners"], focus: "runners" }, …)`. Набор
  компонентов `./ui.js` тот же, что импортирует `aq.js:13-16`.
- Produces (именованные экспорты для задачи 4 и тестов):
  - `export function serverRows(model) -> Array<{key, server}>` — серверы по порядку модели, пусто, если не `live`.
  - `export function runnersLine(v) -> {text, tone} | null` — `v?.line ?? null`.
  - `export function runnersBadge(v) -> {count, tone} | null` — `v?.badge ?? null`.
  - `export default class Runners` — `init/close/command/render`, по образцу `aq.js:67-130` и `aq.js:552-583`.

Экран (сверху вниз; детали раскладки и цвета решает исполнитель, в стиле `aq`):
- `PageHeader({ icon: "server", title: "Runners", description })`. `description` = `line.text`, а для не-`live` состояний
  `"Cloud CI runners from ci-runners"`. Справа от заголовка — `tick {ago} ago` (оттенок `warning` при `tick.stale`).
- Предупреждения: каждое из `warnings` — строка с `triangle-alert` и `text` сервиса. Если `tick.stale`, весь блок данных
  ниже приглушён (`opacity`) и подписан «as of {tick.ago} ago».
- Плитки (`Metric`): `Servers` (`servers`), `Busy` (`busy / runners`), `Queued` (только если `queued != null`; при
  `queue_ago` подпись «as of {queue_ago} ago»), `Cost now` (`cost` и подпись «estimate», только если не `null`).
- Список серверов: имя, роль, статус (с `drain`), `age`, фаза словами (`busy`, `idle {runner.idle}`, `booting`,
  `draining`, `building image`), `next.text`, `cost`. Строка с `warned` помечена `triangle-alert`.
- Боковая панель выбранного сервера (`SidePanel`, при ширине ≥ 960 как `aq`): все поля сервера из модели, ID моноширинным.
- Внизу тихая строка `"Stats over a period will show here once ci-runners has stats --json."`.
- Состояния: модели нет → `Skeleton`, как в `aq.js:529-533`. `absent` → `Empty({ icon: "server", title: "ci-runners is not installed here", description: "Install ci-runners on the machine the hub runs on (or set CI_RUNNERS_BIN), and its cloud runners show here." })`.
  `outdated`/`newer`/`down` → `ErrorState({ title: line.text, message: error })`. `no-tick` → `Empty` с
  `"The tick has not run yet"` и подсказкой `ci-runners tick install`.
- Клавиши: `j`/`k` — выбор сервера. `KeyHints([["j k", "move"]])`. Никаких действий и меню.

- [ ] **Step 1: Write the failing tests** (`app/tests/runners.test.mjs`)
  - `"rows follow the model's servers"`: `serverRows(model).map(r => r.server.name)` даёт
    `["sel-ci-demo1", "sel-ci-demo2", "sel-img-demo"]`. Для не-`live` модели — `[]`.
  - `"line and badge come from the model as they are"`: `runnersLine`/`runnersBadge` возвращают поля модели, а для `null` — `null`.
  - `"j and k walk the servers"`: по образцу теста `aq.test.mjs:105`.
  - `"no queue tile when the service sends none"`: модель с `tiles.queued = null` → в отрисованном дереве нет текста `Queued`
    (тем же способом, каким `aq.test.mjs` проверяет отрисовку; если так нельзя, проверять экспортируемую функцию
    `tiles(model)`, которая возвращает массив плиток).
- [ ] **Step 2:** `node --experimental-vm-modules --test app/tests/runners.test.mjs` — FAIL.
- [ ] **Step 3:** реализовать `runners.js`, подключить в `main.js`.
- [ ] **Step 4:** тот же запуск — PASS. `node --input-type=module --check < app/mods/cockpit/runners.js` проходит.
- [ ] **Step 5:** Commit `runners: the Runners space in the mod`.

### Task 4: подключение к оболочке (сайдбар, Home, переходы, клавиши, раскладки)

**Files:**
- Modify: `app/mods/cockpit/sidebar.js:22-58` — `runners: { label: "Runners", icon: "server" }` в `APPS`;
  `runners: ["badge", "state"]` в `BADGE_FIELDS`; `appBadge` для `runners` → `v.badge`.
- Modify: `app/mods/cockpit/sidebar.js:130-131,248` — вместо единственного флага `this.aq` завести набор приложений,
  которые появляются сами (`aq`, `runners`). Иконка добавляется в конец `pinned`, когда у вида `state` не `absent`
  и не `undefined`.
- Modify: `app/mods/cockpit/home.js:68,916` — строка `{ view: "runners", space: "runners", label: "Runners", icon: "server", line: (v) => v.line ?? null }`.
  В фильтре `runners` показывается так же, как `aq`: всегда, когда есть строка.
- Modify: `app/mods/cockpit/hub.js:85,87` — `"runners"` в `APPS` и `runners: "runners"` в `SPACES`.
- Modify: `app/mods/cockpit/screens.js:8-17` — `["runners", "Runners", "server"]`.
- Modify: `app/mods/cockpit/placeholder.js:6` — `runners: ["Runners", "server"]`.
- Modify: `app/layouts/cockpit.json:155` и `app/layouts/cockpit-chat.json:376-385` — блок `runners` рядом с блоком `aq`,
  с теми же свойствами.
- Modify: `app/keys.json:12` — `"cmd-alt-9": "cockpit.go:runners"`.

**Interfaces:**
- Consumes: `runnersLine`, `runnersBadge` (задача 3), вид `runners` (задача 2).

- [ ] **Step 1: Write the failing tests**
  - В `app/tests/runners.test.mjs`: `"the sidebar shows Runners only when the hub finds ci-runners"` — модель с `state: "absent"`
    не добавляет иконку, а с `state: "live"` добавляет её в конец. Тест идёт через экспорт из `sidebar.js`, если он
    есть. Если нет, вынести расчёт `pinned` в экспортируемую чистую функцию `autoApps(spaces, states)` и тестировать её.
  - Запустить весь набор: `node --experimental-vm-modules --test app/tests/*.test.mjs`. Тесты клавиш и раскладок
    (`keys.test.mjs`, `window-commands.test.mjs`, `panels.test.mjs`) должны упасть или потребовать новый ключ и блок.
    Если ни один не падает, добавить в `keys.test.mjs` проверку, что `cmd-alt-9` ведёт на `cockpit.go:runners`.
- [ ] **Step 2:** запуск — FAIL.
- [ ] **Step 3:** внести изменения из списка файлов.
- [ ] **Step 4:** весь набор `app/tests` — PASS. `node --input-type=module --check` на каждом изменённом `.js` проходит.
- [ ] **Step 5:** Commit `runners: sidebar, Home, keys and layouts`.

### Task 5: документация, просмотр в песочнице, общий прогон

**Files:**
- Modify: `docs/app.md` — новый раздел `## View runners (the Runners space, app only)` после раздела `aq` (`docs/app.md:1555`):
  откуда данные, правило «никаких сетевых вызовов», контракт модели (блок `jsonc` из этого плана), что пространство
  появляется само и не входит в `spaces`. В строке 185 добавить `cmd-alt-9` → `cockpit.go:runners`.
- Modify: `app/RECIPE.md:25,57,93,131,135` — `Runners` рядом с `aq`.
- Create: `scripts/fake-ci-runners.sh` — поддельный `ci-runners` для песочницы: на `version --json` и
  `status --json --offline` печатает фикстуры из `herdr/tui/runners/tests/fixtures/`. `shellcheck -S warning` чист.

- [ ] **Step 1:** песочница: `CI_RUNNERS_BIN=$PWD/scripts/fake-ci-runners.sh COCKPIT_SANDBOX=/tmp/cc-r HC_SESSION=cc-r sh scripts/sandbox.sh start`,
  затем `sh scripts/sandbox.sh show runners`. Снять `shot` в светлой и тёмной теме. Проверить глазами: плитки,
  предупреждение у `sel-ci-demo2`, плитку Queued, боковую панель, иконку в сайдбаре и строку на Home.
  `sh scripts/sandbox.sh check` проходит. `stop`.
- [ ] **Step 2:** повторить с фикстурой, где есть предупреждение `tick-stale` (переменная окружения скрипта выбирает
  фикстуру), и снять один кадр: данные приглушены, подпись «as of …».
- [ ] **Step 3:** общий прогон через aq (`aq submit --memory 5G --cpus 4 … -- env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE HC_BIN=/nonexistent/hc CARGO_BUILD_JOBS=4 RUST_TEST_THREADS=4 sh -c '…'`):
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace`,
  `node --experimental-vm-modules --test app/tests/*.test.mjs`, `shellcheck -S warning scripts/fake-ci-runners.sh`.
  Известные падения этого хоста (`hub_env::tests::a_login_shell_is_read_on_the_account_s_names_alone`,
  `act::start::tests::cancel_ends_a_driven_setup_before_its_worktree_goes`) перезапускаются по одному и в отчёте
  указываются как особенности хоста.
- [ ] **Step 4:** Commit `runners: docs, sandbox fake and screenshots`. Скриншоты передаются пользователю путями в `/tmp`,
  в репозиторий они не коммитятся.

---

## Вне этого плана

- Кнопки (пауза, максимум, «осушить все») — отдельный план после спеки автоподъёма сервиса.
- Часть «За период» — отдельный план, когда у сервиса будет `stats --json` без сети.
- Сам ci-runners (`inventory.json`, `status --json --offline`, `version --json`, флаг очереди) делает сессия сервиса по ТЗ (amail #256).
