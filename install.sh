#!/bin/sh
# Установка ccsync (macOS / Linux):
#   curl -fsSL https://raw.githubusercontent.com/rtst01/transfer-claude-config/main/install.sh | sh
set -e

REPO="rtst01/transfer-claude-config"

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *) echo "Неподдерживаемая ОС: $(uname -s). Используй npm: npm i -g git+https://github.com/$REPO.git"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64)        ARCH="x64" ;;
  *) echo "Неподдерживаемая архитектура: $(uname -m)"; exit 1 ;;
esac

ASSET="ccsync-$OS-$ARCH.tar.gz"
URL="https://github.com/$REPO/releases/latest/download/$ASSET"

# каталог установки: первый доступный на запись из PATH-кандидатов
for DIR in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  [ -d "$DIR" ] && [ -w "$DIR" ] && INSTALL_DIR="$DIR" && break
done
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

echo "Скачиваю $ASSET ..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# прогресс-бар только в интерактивном терминале
if [ -t 1 ]; then PROGRESS="--progress-bar"; else PROGRESS="-s"; fi
curl -fSL $PROGRESS "$URL" -o "$TMP/$ASSET"
tar -xzf "$TMP/$ASSET" -C "$TMP"
mv "$TMP/ccsync" "$INSTALL_DIR/ccsync"
chmod +x "$INSTALL_DIR/ccsync"

# macOS: снять карантин, иначе Gatekeeper заблокирует неподписанный бинарь
if [ "$OS" = "macos" ]; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/ccsync" 2>/dev/null || true
fi

echo "✓ Установлено: $INSTALL_DIR/ccsync"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) echo "Запускай: ccsync" ;;
  *) echo "⚠ $INSTALL_DIR не в PATH — добавь в свой профиль шелла:"
     echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
