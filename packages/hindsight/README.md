# pi-durable-hindsight

Память Hindsight для Durable Harness: admission привязывает ввод к банку, pinned-контекст попадает в model request, а durable outbox сохраняет доставку до подтверждения сервера. Алгоритмы Hindsight закреплены на 0.8.0; peers — `@earendil-works/pi-durable` и `@earendil-works/chord` **1.0.2**. Нужен **Node.js ≥24** для host SQLite.

Это **trusted Durable registry adapter**, не обычный Pi `ExtensionAPI` plugin. `pi install` не обеспечивает совместимость; автоматической регистрации расширения для обычного Pi нет. Для pi-pocket нужна отдельная адаптация runtime.

## Portable collection candidate

This retained candidate is a standalone package for a Durable host. It does not import Pi Pocket or require a Pocket workspace. The package is currently a local **experimental candidate** pending independent static review and distinct behavioral QA; it is not a stable distribution or live-memory-service claim.

Requirements measured locally: Node.js `24.19.0`, npm `11.17.0`, `@earendil-works/pi-durable` `1.2.0`, `@earendil-works/chord` `1.2.0`, and dev `@earendil-works/pi-ai` `1.2.0`. Node `>=24` is the declared engine. Keep `autoSeed:false`, `autoUpdate:false`, `codebaseSurvey:false`, `retainSessions:false`, and `autoInject:'none'` in deterministic/offline hosts unless each external effect is explicitly authorized. No credentials, source history, or live Hindsight service is included.

From the common repository's supported manual route, use the exact hash-verified bundle artifact and run the retained faux/local example from the unpacked target root:

```sh
node examples/bare-durable.mjs
```

The common repository root `docs/installation.md` and `scripts/manual-route-proof.mjs` own the public install, runtime-dependency, and faux/local proof route. Fresh consumers may download anonymous public npm dependencies; this route is not claimed to be network-free and does not use `--offline`. The faux/local examples make no live provider, backend, account, quota, or service calls. Private candidate QA helpers are not shipped in this package.

The example invokes a real Durable `Harness` with a local faux model and SQLite storage. It retains its run directory and does not prove a real Hindsight backend, detached launch, or Pocket adapter. Binding is required after `Harness.open` and before `resume`/submit; host shutdown must close admission for root and child inputs, drain delivery, then close the controller before native Harness/session shutdown. Use the stable `requestId` and original content when replaying an ambiguous submission.

Adapter-owned session directories are created or accepted only at mode `0700`; log, diagnostic, usage, and pinned cache files are created exclusively at mode `0600`. Symlinks, insecure existing paths, and paths owned by another user fail closed. Cache reads use a Linux-only `O_NOFOLLOW` open handle with owner/mode/regular-file checks and an 8 MiB bound; the handle is closed and never deleted. The candidate never chmods an existing path and never follows a cache-file symlink. Unsupported Linux trust-boundary capabilities fail closed. These checks are exercised with retained fixtures under process umask `022`; fixture directories and SQLite/cache artifacts are intentionally not cleaned up.

Trust-boundary limitation: this candidate does not claim atomic `openat2`/descriptor-root containment against a concurrently hostile same-UID host. An already-authorized same-UID host can still replace checked `0700` ancestors or `0600` files outside the helper's control; that scenario is outside the approved trusted-host boundary. The candidate retains path checks and final no-follow handle checks rather than adding a new descriptor framework.

## Получение

Для этого кандидата не публикуется отдельный GitHub/npm bootstrap route. Используйте common repository root `docs/installation.md` и свежий caller-owned bundle; private candidate QA/provenance helpers остаются во внешнем integration-prep evidence.

`npm install` устанавливает JS-зависимости, **не Hindsight service**. Настройте сервис и доступ отдельно через существующий Hindsight config/auth pipeline; секреты храните вне репозитория. The public root catalog and generated bundle catalog record package versions and exact packed-artifact SHA-256 values only; they do not contain raw source evidence or private provenance receipts.

The packed artifact does not include private QA/provenance helpers or retained evidence files. Use the common repository's fresh unpacked-target manual route; `SECURITY.md` describes package trust boundaries, while the root docs and private proof receipt describe the actual bundle checks.

## Подключение

В Durable main loader, поддерживающем `--extension`, передайте абсолютный путь к клону:

```sh
# Аргумент вашего Durable launcher, не обычного Pi:
# --extension "$(pwd)/src/adapter.mjs"
```

Default export `src/adapter.mjs` — функция `(registry) => registry`. Она устанавливает extension `hindsight` и task `hindsight.deliver`, но не открывает Harness. Само загрузочное действие не запускает сервис. Host обязан поддерживать handoff контроллера; одного флага недостаточно для произвольного runtime.

Минимальный host-фрагмент (storage, models, context, sessionDirectory, cwd и model задаёт ваш host):

```js
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import install from './src/adapter.mjs';

const key = Symbol.for('pi.durable.hindsight.controller');
const base = createRegistry();
const registry = await install(base);
const memory = registry.snapshot().extension('hindsight')?.[key];
// Передавайте актуальный controller следующему вызову adapter при reload.
Object.defineProperty(base, key, { value: memory, configurable: true });
const session = await Harness.open(storage, { models, registry }, context);
await memory.bind({ session, storage, directory: sessionDirectory, context });
// Binding обязателен после open, ДО resume/submit/wait.
const root = await session.root(context, { agent: { cwd, model } });
// Root/cwd/model должны быть готовы до возобновления сохранённых tasks.
session.resume();
const requestId = 'durably-recorded-input-id'; // новый для нового логического ввода
await memory.admit(root, requestId, context);
const submission = await root.submit({
  type: 'input', content: 'Задача', requestId, whenBusy: 'followUp'
}, context);
await submission.wait(context);
```

Повтор admission/submit после неоднозначного сбоя должен использовать **тот же requestId и content**. Не заменяйте ID и не пересылайте старую задачу как новую. `memory.submit(root, content)` удобен для нового ввода, но сам генерирует UUID; для восстановления используйте явный стабильный ID. Harness/storage остаются нативными, outbox не заменяет transcript.

Дочерний ввод тоже требует admission **до submit**. Если ваш host имеет собственную фабрику `createSubagent`, подключите её callback к `memory.admit(child, requestId, childContext)`. **Эта библиотека не экспортирует `createSubagent`**: host должен реализовать seam через native `defineTool`, task-owned conversation и стабильный ID. Приватный QA source и retained evidence находятся в `test/integration.test.mjs`; этот файл не входит в packed artifact, не является install/run example и не должен использоваться как public route. Для public proof используйте common repository `docs/installation.md` и `scripts/manual-route-proof.mjs` с faux/local example.

### Reload и закрытие

Host сериализует reload с admission, ждёт idle и публикует проверенный registry candidate. Controller находится на extension через `Symbol.for`; на base registry host сохраняет handoff для следующей загрузки.

- Тот же controller: сохранить binding, не вызывать `bind` повторно.
- Новый controller: приостановить новые admissions, `drain` и `close` старого, обновить handoff, привязать новый к тому же Harness/storage. Не отправлять transcript заново.
- Удаление adapter: очистить handoff и закрыть старый controller. Уже установленные delivery tasks нельзя молча потерять: учитывайте pending receipts и сохраняйте необходимые task definitions до их завершения или последующего восстановления.
- Ошибка candidate до публикации: оставить прежний registry/controller и binding. Ошибка нового binding: закрыть новый controller, выключить memory seam; не выдавать это за успешную доставку.

При shutdown немедленно закройте host admission gate для **пользовательского и дочернего ввода**: callback `createSubagent` должен отказывать в новых admission/submit с начала закрытия, даже если родитель ещё выполняется. Дождитесь уже допущенной host-очереди; затем `await memory.drain()`, `await memory.close()`, `await session.close(context)`. Native Harness close закрывает admission, уведомляет close listeners/cancels task execution, ждёт task invocations (`beforeClose`/join), затем **сам закрывает Storage** с cleanup context без abort signal. Не закрывайте storage заранее или повторно: native cancellation/checkpoint должны успеть записаться. После `session.close` закройте только оставшиеся host-owned ресурсы. `drain` ограничивает ожидание, не гарантирует доставку. Pending/uncertain остаются в SQLite; queued acceptance не доказывает extraction. Не повторяйте uncertain non-idempotent effects вручную без проверки результата.

## Стоимость и приватность

Native config сохраняет свои defaults: autoSeed, autoUpdate, codebaseSurvey и retention могут обращаться к сети, запускать процессы, загружать исходники/историю и тратить средства. До первого binding проверьте config; при ненужных действиях явно задайте `autoSeed:false`, `autoUpdate:false`, `codebaseSurvey:false`, `retainSessions:false`, `autoInject:'none'` через существующий config. Репозиторий не меняет ваши настройки автоматически. Для полного отключения используйте `disabled:true`.

`HINDSIGHT_DISABLE_HOOKS` отключает автоматический контекст/lifecycle/delivery, **не ручные memory tools**. `cfg.disabled` также отключает tools. Не задавайте строку `false` для disableHooks: в этом API любое непустое значение истинно.

SQLite, cache, memory logs и diagnostics могут содержать полный prompt, memory text и retention payload в незашифрованном виде. Adapter задаёт log/diag/usage paths внутри session directory, только если env ещё не задан; существующие overrides имеют приоритет. Эти пути process-wide: параллельные hosts не изолированы. Ограничьте доступ к session directory и не публикуйте runtime-файлы. `.gitignore` — не проверка отсутствия секретов.

## Проверки и лицензия

The common repository's root `npm run check` validates public-tree privacy/symlink boundaries, while `scripts/manual-route-proof.mjs` performs the actual packed-target faux/local proof. Private source QA and provenance helpers are retained outside this package and are not advertised as package commands. Обычные npm exports work without `--conditions=source` or a TS transpilation hook where the host uses the supported unpacked-target route.

Derived Pi code: [MIT LICENSE](LICENSE), исходное copyright сохранено. Новые файлы проекта: MIT, Copyright (c) 2026 pi-durable-hindsight contributors. Hindsight: [отдельный MIT LICENSE](src/vendor/LICENSE). Private source hashes, provenance receipts, and verification journals are retained outside this package and are not linked as distributed files. The common repository root catalog and generated bundle catalog provide package/version/artifact SHA-256 metadata only; they are not raw-evidence manifests. Bundled third-party attribution and license texts remain in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/`. This is not a blanket legal/runtime privacy guarantee; verify the exact allowlist before publication.
