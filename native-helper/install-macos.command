#!/bin/sh
set -eu

HOST_NAME="com.manemark.storage"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
EXT_ID="${1:-}"

if [ -z "$EXT_ID" ]; then
  printf "Paste the Manemark extension ID shown on its Storage settings page: "
  IFS= read -r EXT_ID
fi
if [ -z "$EXT_ID" ]; then
  echo "No extension ID supplied."
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) HOST_PATH="$ROOT/macos-arm64/manemark-native-host" ;;
  x86_64) HOST_PATH="$ROOT/macos-intel/manemark-native-host" ;;
  *) echo "Unsupported Mac architecture: $ARCH"; exit 1 ;;
esac

chmod +x "$HOST_PATH"
DEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST="$DEST_DIR/$HOST_NAME.json"
mkdir -p "$DEST_DIR"

# Escape only the JSON characters that can occur in normal POSIX paths/IDs.
ESCAPED_HOST=$(printf '%s' "$HOST_PATH" | sed 's/\\/\\\\/g; s/"/\\"/g')
cat > "$MANIFEST" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Manemark custom folder storage helper",
  "path": "$ESCAPED_HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON

echo
echo "Installed successfully for extension ID: $EXT_ID"
echo "Return to Manemark Storage settings and click Choose folder."
