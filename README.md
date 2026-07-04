# ccsync — синхронизация настроек Claude Code

Переносит и синхронизирует конфигурацию Claude Code между машинами
(**Windows ⇄ macOS ⇄ Linux**): настройки, агентов, скиллы, команды, память,
keybindings, statusline и список MCP-серверов.

Standalone-бинарь ничего не требует (для git-режима нужен git);
npm-вариант — Node.js ≥ 18. Внешних зависимостей у пакета нет.

## Что синхронизируется

| Артефакт | Откуда |
|---|---|
| `settings.json` | `~/.claude/` (с адаптацией путей под ОС) |
| `CLAUDE.md` (глобальная память) | `~/.claude/` |
| `keybindings.json` | `~/.claude/` |
| `statusline.sh` | `~/.claude/` (на Windows — только при наличии Git Bash) |
| `agents/`, `skills/`, `commands/` | `~/.claude/` |
| `mcpServers` | только этот блок из `~/.claude.json` |

**Никогда не трогается:** `settings.local.json` (машинно-локальное),
история, сессии, кэш, telemetry, плагины (переустанавливаются через `/plugin`).

## Установка

### Вариант 1: готовый бинарь (Node.js не нужен)

Одна команда — скачает свежий релиз под твою ОС/архитектуру, распакует,
положит в PATH и снимет карантин (macOS):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/rtst01/transfer-claude-config/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/rtst01/transfer-claude-config/main/install.ps1 | iex
```

Вручную: на странице [Releases](https://github.com/rtst01/transfer-claude-config/releases)
лежат `ccsync-macos-arm64.tar.gz`, `ccsync-macos-x64.tar.gz`,
`ccsync-linux-x64.tar.gz`, `ccsync-windows-x64.zip` (+ SHA256SUMS.txt).
Внутри архива бинарь уже называется `ccsync` с выставленным execute-битом —
распаковать и положить в PATH. Это консольная программа: запускается из
терминала, двойной клик в Finder/Explorer не сработает.

Имя `ccsync` в PATH важно для авто-синхронизации — хуки вызывают именно его.

### Вариант 2: через npm (нужен Node.js ≥ 18)

```bash
npm install -g git+https://github.com/rtst01/transfer-claude-config.git
```

После этого команда `ccsync` доступна отовсюду (npm сам создаёт `ccsync` для
Mac/Linux и `ccsync.cmd`/`ccsync.ps1` для Windows).

Разовый запуск без установки:

```bash
npx github:rtst01/transfer-claude-config          # откроет меню
npx github:rtst01/transfer-claude-config export   # или сразу команду
```

Обновление в обоих вариантах: `ccsync update` — сам определит способ установки
(подменит бинарь или прогонит `npm install -g`).

Для разработки: `git clone … && cd transfer-claude-config && npm link`.

## Интерфейсы

Все три интерфейса дают одни и те же возможности:

```bash
ccsync            # интерактивное меню в терминале (работает и по ssh)
ccsync ui         # веб-панель в браузере (только localhost)
```

Веб-панель: «рельса синхронизации» эта машина ⇄ репозиторий с Push/Pull,
drag-n-drop файла .ccsync (дифф или импорт, включая зашифрованные), экспорт
с шифрованием, бэкапы с откатом в один клик, история, doctor, самообновление.
Все диалоги — собственные, в стиле панели.

## Способ 1: архив (разовый перенос)

На старой машине:

```bash
ccsync export                # → claude-config-<hostname>-<дата>.ccsync
```

Файл переносится как угодно (AirDrop, флешка, мессенджер). На новой машине:

```bash
ccsync import файл.ccsync --dry-run   # посмотреть план
ccsync import файл.ccsync             # применить (с бэкапом)
```

Зашифрованный архив (можно слать через мессенджер):

```bash
ccsync export --encrypt              # спросит пароль, AES-256-GCM
ccsync import файл.ccsync            # спросит пароль сам
CCSYNC_PASSPHRASE=… ccsync import …  # или через переменную/--password=…
```

## Способ 2: git (постоянная синхронизация)

Один раз: создай **приватный** репозиторий на GitHub. Затем на каждой машине:

```bash
ccsync init git@github.com:you/claude-config.git
```

Дальше рабочий цикл:

```bash
ccsync push        # выгрузить локальный конфиг в репо (авто-коммит + push)
ccsync pull        # забрать из репо и применить (merge + авто-бэкап)
ccsync status      # краткие отличия от репо
ccsync diff        # подробный дифф (или ccsync diff файл.ccsync — против архива)
```

`push` сам делает `pull --rebase` перед отправкой, пустые изменения не коммитит.

### Авто-синхронизация

```bash
ccsync autosync on      # хуки Claude Code: pull при старте сессии,
                        # push при завершении. Журнал: ~/.claude/ccsync.log
ccsync autosync status  # состояние + последние записи журнала
ccsync autosync off
```

Pull троттлится (не чаще раза в 30 минут), хуки всегда завершаются успешно и
ничего не выводят — сессия Claude Code не пострадает, даже если сеть недоступна.
Хуки уезжают вместе с settings.json, поэтому на других машинах тоже нужен
установленный `ccsync`.

### Умный merge

При `pull`/`import` настройки не затираются, а сливаются:

- `permissions.allow/deny/ask` — объединение списков (локальные правила не теряются);
- `env`, `enabledPlugins` — локальные ключи сохраняются, по общим побеждает входящее;
- остальное (theme, model, statusLine, hooks) — входящее как источник истины.

Нужна точная копия без merge — `ccsync pull --overwrite` / `ccsync import --overwrite`.

## Кроссплатформенность

При применении на другой ОС автоматически:

- пути `/Users/name/...` ⇄ `C:\Users\name\...` переводятся под текущую систему
  (в репо и архиве хранятся в портируемой форме `~/...`);
- разделители `/` ⇄ `\` нормализуются в строках-путях;
- `statusline.sh` и `statusLine` из настроек **не применяются** на Windows без
  Git Bash (вместо поломки — понятное предупреждение);
- хуки с unix-командами (`grep`, `sed`, `.sh`) помечаются предупреждением;
- синк-репо — байтовое зеркало: eol-конвертации git отключены полностью
  (`* -text` + `core.autocrlf=false`), иначе CRLF на Windows давал бы
  фантомные отличия в `status`.

## Бэкапы и откат

Перед **каждым** применением (`import` и `pull`) всё, что будет перезаписано,
автоматически копируется в `~/.claude/backups/ccsync-<время>/` — включая
`~/.claude.json` (перед merge MCP-серверов).

```bash
ccsync backups              # список бэкапов с содержимым
ccsync restore              # откатить последний бэкап
ccsync restore 2            # откатить конкретный (номер из списка)
ccsync restore --dry-run    # посмотреть, что будет восстановлено
```

Откат доступен также из TUI-меню (пункт 7) и веб-панели («Бэкапы и откат» —
список с датами и кнопкой отката у каждой записи).
Откат строгий: перезаписанные файлы восстанавливаются, а добавленные
импортом — удаляются (по манифесту бэкапа) — состояние «до байта».

## Сервисные команды

```bash
ccsync log        # история синхронизаций: кто, когда, что менял
ccsync doctor     # диагностика: git, bash, PATH, репо, хуки, карантин — с рецептами
ccsync update     # самообновление до последнего релиза (SEA-бинарь или npm)
ccsync version    # текущая версия
```

`ccsync status` раз в сутки тихо проверяет наличие новой версии и подсказывает
обновиться.

## Безопасность

- Перед каждым применением старые файлы копируются в
  `~/.claude/backups/ccsync-<время>/` (см. «Бэкапы и откат»).
- При экспорте/пуше сканируются строки, похожие на API-ключи
  (`sk-ant-…`, `ghp_…`, AWS, Slack) — при находке будет предупреждение.
- В выводе `diff` значения ключей с именами `key/token/secret/password`
  маскируются (`"688…66"`) — дифф безопасен для скриншотов.
- Секреты держи в `settings.local.json` — он не синхронизируется.
- Репозиторий синхронизации должен быть **приватным**.
- Веб-панель слушает только `127.0.0.1`, команды — по белому списку.

## Как это устроено

```
bin/ccsync.js    CLI
lib/config.js    манифест синхронизации, пути, детект ОС/bash
lib/collect.js   сбор конфига + нормализация путей в ~/... + скан секретов
lib/bundle.js    формат .ccsync (gzip-JSON), шифрование AES-256-GCM
lib/apply.js     умное применение: адаптация путей, merge, бэкапы
lib/diff.js      содержательный дифф архива против локальной конфигурации
lib/git.js       init/push/pull/status/diff через git
lib/autosync.js  хуки Claude Code (autopull/autopush), журнал, троттлинг
lib/backups.js   список бэкапов, строгий откат по манифесту
lib/update.js    самообновление с GitHub Releases, ежедневная проверка версии
lib/doctor.js    диагностика окружения с рецептами
lib/tui.js       интерактивное меню в терминале
lib/webui.js     локальный http-сервер веб-панели (whitelist команд, 127.0.0.1)
lib/panel.html   страница веб-панели
test/e2e.js      сквозной тест (npm test), гоняется в CI на win/mac/linux
scripts/build-sea.js  сборка standalone-бинаря (Node SEA), запускается в Release CI
```

Релиз бинарей: `git tag v0.x.0 && git push --tags` — workflow Release соберёт
бинари на 4 раннерах (linux-x64, macos-x64, macos-arm64, windows-x64),
прогонит тесты и приложит их к GitHub Release с чек-суммами.

Служебный конфиг инструмента: `~/.claude/ccsync.json` (не синхронизируется).
Переменная `CCSYNC_HOME` переопределяет домашнюю директорию (для тестов).
