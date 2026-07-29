# Сборка Chatick под macOS

Собирать DMG можно **только на маке** — electron-builder вызывает системные
утилиты Apple (`hdiutil`, `codesign`), которых на Windows и Linux нет.

---

## 1. Что нужно на машине

| | Зачем |
|---|---|
| **macOS 12+** | ниже не соберётся Electron 38 |
| **Xcode Command Line Tools** | `hdiutil`, `codesign` — без них сборка падает |
| **Node.js 22** | версия, на которой собирается всё остальное |
| **pnpm 9+** | монорепозиторий держится на нём |

```bash
xcode-select --install                 # если ещё не стоят
node -v                                # ожидаем v22.x
corepack enable && corepack prepare pnpm@latest --activate
```

Если Node ставится впервые — проще через `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22 && nvm use 22
```

---

## 2. Подготовка репозитория

```bash
git clone https://github.com/unbywyd/chatick.git
cd chatick
pnpm install
```

`pnpm install` из корня — обязательно: приложение тянет зависимости из общих
пакетов монорепозитория, установка внутри `apps/desktop` их не увидит.

---

## 3. Сборка

```bash
pnpm --filter @chatick/desktop dist
```

Готовое лежит в `apps/desktop/release/`:

```
Chatick-0.3.7-arm64.dmg      Apple Silicon (M1–M4)
Chatick-0.3.7-x64.dmg        Intel
```

Собираются **обе архитектуры сразу** — так задано в `package.json`. Отдать людям
только arm64 нельзя: на Intel-маках он просто не запустится, а понять из
названия файла, какой скачивать, обычный человек не обязан.

Если нужна только своя, ради скорости:

```bash
pnpm --filter @chatick/desktop dist -- --mac --arm64     # или --x64
```

Сборка x64 на Apple Silicon идёт через Rosetta. Если её нет:
`softwareupdate --install-rosetta`.

---

## 4. Проверка перед раздачей

```bash
# Открыть образ и убедиться, что приложение запускается
open release/Chatick-0.3.7-arm64.dmg

# Посмотреть, что внутри и какая архитектура
file release/mac-arm64/Chatick.app/Contents/MacOS/Chatick

# Проверить подпись (см. раздел 5 — без сертификата будет "not signed")
codesign -dv --verbose=4 release/mac-arm64/Chatick.app 2>&1 | head -5
spctl -a -vvv release/mac-arm64/Chatick.app
```

---

## 5. Подпись и нотаризация

**Сейчас сборки не подписаны.** Это осознанное состояние, а не упущение:
сертификат Apple стоит 99 $ в год, и пока приложение в бете он не куплен.

Что видит человек, скачавший неподписанный DMG:

> «Chatick» нельзя открыть, так как Apple не может проверить это ПО
> на наличие вредоносных компонентов.

Обходится через **Правой кнопкой → Открыть → Открыть** (или
Системные настройки → Конфиденциальность и безопасность → «Всё равно открыть»).
Это описано на сайте в разделе про неподписанные сборки — врать людям про это
не нужно.

### Когда сертификат появится

Нужен **Apple Developer Program** (99 $/год) и сертификат
*Developer ID Application*. Дальше:

```bash
export APPLE_ID="почта@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com → App-Specific Password
export APPLE_TEAM_ID="XXXXXXXXXX"                          # Membership → Team ID
export CSC_LINK="/путь/к/certificate.p12"
export CSC_KEY_PASSWORD="пароль от p12"

pnpm --filter @chatick/desktop dist
```

electron-builder сам подпишет и отправит на нотаризацию. Она идёт через
серверы Apple и занимает от пары минут до получаса — сборка будет ждать.

В `package.json` под ключ `mac` тогда добавить:

```json
"hardenedRuntime": true,
"gatekeeperAssess": false,
"entitlements": "build/entitlements.mac.plist",
"entitlementsInherit": "build/entitlements.mac.plist",
"notarize": { "teamId": "XXXXXXXXXX" }
```

> **Проверка подписи после сборки** (`scripts/check-signature.mjs`) сейчас
> работает только на Windows — на маке она молча пропускается. То есть
> «сборка прошла без предупреждений» на маке **не значит «подписано»**.
> Проверяйте руками через `codesign` и `spctl` из раздела 4.

---

## 6. Что важно знать про macOS-версию

- **Приложение грузит интерфейс с `app.chatick.com`** (`LOAD_MODE = 'remote'`
  в `main.cjs`). Пересобирать десктоп ради изменений в вебе не нужно — они
  приезжают сами. Локальная копия в `web/` — запасная, на случай без сети.
- **Закрытие окна не выходит из приложения** — оно живёт в строке меню, как
  принято на маке. Выход — через меню значка.
- **Бейдж непрочитанных** рисуется на иконке в доке (`app.dock.setBadge`).
- **Значок в строке меню** выбирается по светлой/тёмной теме системы. Это не
  template-изображение в терминах Apple, поэтому в редких темах он может
  выглядеть контрастнее соседних — знаем, не критично.

---

## 7. Если сборка падает

| Ошибка | Причина и что делать |
|---|---|
| `hdiutil: command not found` | Нет Xcode CLT → `xcode-select --install` |
| `Cannot find module 'electron'` | Ставили внутри `apps/desktop`. Нужно `pnpm install` из корня |
| `Application entry file "main.cjs" does not exist` | Собираете не из той папки — только через `pnpm --filter` из корня |
| `code signing failed` при отсутствии сертификата | Ожидаемо. Для сборки без подписи: `export CSC_IDENTITY_AUTO_DISCOVERY=false` |
| Зависает на `notarizing` | Ждёт ответа Apple, это нормально до получаса. Смотреть `xcrun notarytool log` |
| `sharp` не ставится | Нужен только для `make-icons.mjs`, к сборке DMG отношения не имеет |

---

## 8. Публикация

Сборки раздаются с `https://chatick.com/releases` (`publish.provider: generic`).
Автообновление на маке работает только для **подписанных** сборок — Squirrel.Mac
отказывается ставить обновление, которое не прошло проверку. До покупки
сертификата macOS-версия обновляется только вручную, новой загрузкой DMG.
