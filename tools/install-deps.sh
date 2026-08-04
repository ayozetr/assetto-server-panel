#!/usr/bin/env bash
# =============================================================================
# Assetto Server Panel — Instalador de binarios del sistema para extracción
# de mods en formato .rar y .7z.
#
# NOTA: El panel ya incluye soporte nativo para los tres formatos mediante
# paquetes npm (node-stream-zip, node-unrar-js, 7zip-bin) que NO requieren
# ningún binario del sistema operativo.
#
# Usa este script SOLO si deseas que el panel use los binarios del sistema
# en lugar de los empaquetados en npm, o si los paquetes npm no están
# disponibles en tu plataforma.
# =============================================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Detect OS ─────────────────────────────────────────────────────────────────
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_ID_LIKE="${ID_LIKE:-}"
  elif [ "$(uname)" = "Darwin" ]; then
    OS_ID="macos"
  else
    OS_ID="unknown"
  fi

  # Normalise to family
  case "$OS_ID" in
    ubuntu|debian|raspbian|linuxmint|pop|kali) FAMILY="debian" ;;
    fedora|rhel|centos|rocky|alma)             FAMILY="fedora" ;;
    arch|manjaro|endeavouros|garuda)           FAMILY="arch"   ;;
    alpine)                                    FAMILY="alpine" ;;
    macos|darwin)                              FAMILY="macos"  ;;
    *)
      # Try ID_LIKE
      case "$OS_ID_LIKE" in
        *debian*|*ubuntu*)  FAMILY="debian" ;;
        *fedora*|*rhel*)    FAMILY="fedora" ;;
        *arch*)             FAMILY="arch"   ;;
        *)                  FAMILY="unknown" ;;
      esac
      ;;
  esac

  info "Sistema detectado: ${OS_ID} (familia: ${FAMILY})"
}

# ── Check root / sudo ──────────────────────────────────────────────────────────
check_sudo() {
  if [ "$(id -u)" = "0" ]; then
    SUDO=""
  elif command -v sudo &>/dev/null; then
    SUDO="sudo"
  else
    error "Se requieren permisos de administrador. Instala sudo o ejecuta como root."
  fi
}

# ── Install functions ──────────────────────────────────────────────────────────
install_debian() {
  info "Actualizando lista de paquetes..."
  $SUDO apt-get update -qq
  info "Instalando unrar-free y p7zip-full..."
  $SUDO apt-get install -y unrar-free p7zip-full
}

install_fedora() {
  info "Instalando unar y p7zip..."
  $SUDO dnf install -y unar p7zip p7zip-plugins
}

install_arch() {
  info "Instalando unrar y p7zip..."
  $SUDO pacman -S --noconfirm unrar p7zip
}

install_alpine() {
  info "Instalando p7zip..."
  $SUDO apk add --no-cache p7zip
  warn "Alpine no tiene unrar en los repositorios oficiales. Para RAR usa el soporte WASM incluido en npm."
}

install_macos() {
  if ! command -v brew &>/dev/null; then
    error "Homebrew no encontrado. Instálalo desde https://brew.sh y vuelve a ejecutar este script."
  fi
  info "Instalando unar y p7zip via Homebrew..."
  brew install unar p7zip
}

# ── Verify installation ────────────────────────────────────────────────────────
verify() {
  local ok=true
  if command -v 7z &>/dev/null || command -v 7za &>/dev/null; then
    info "✔ 7-Zip disponible: $(7z i 2>/dev/null | head -1 || 7za i 2>/dev/null | head -1)"
  else
    warn "✘ 7-Zip no encontrado. El panel usará el binario empaquetado en npm."
    ok=false
  fi

  for cmd in unrar unar; do
    if command -v "$cmd" &>/dev/null; then
      info "✔ $cmd disponible: $($cmd --version 2>&1 | head -1 || echo 'ok')"
      break
    fi
  done
  if ! command -v unrar &>/dev/null && ! command -v unar &>/dev/null; then
    warn "✘ unrar/unar no encontrado. El panel usará node-unrar-js (WASM) para .rar."
    ok=false
  fi

  echo ""
  if $ok; then
    info "✔ Todos los binarios del sistema instalados correctamente."
  else
    info "El panel funciona correctamente mediante los paquetes npm incluidos."
    info "Los binarios del sistema son opcionales y sirven como alternativa."
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo "============================================================"
  echo "  Assetto Server Panel — Instalador de dependencias"
  echo "============================================================"
  echo ""

  detect_os
  check_sudo

  case "$FAMILY" in
    debian)  install_debian  ;;
    fedora)  install_fedora  ;;
    arch)    install_arch    ;;
    alpine)  install_alpine  ;;
    macos)   install_macos   ;;
    *)
      warn "Sistema operativo no reconocido: ${OS_ID}"
      echo ""
      echo "Instala manualmente los siguientes paquetes:"
      echo ""
      echo "  Para .7z: p7zip / 7-Zip"
      echo "    Debian/Ubuntu:  sudo apt install p7zip-full"
      echo "    Fedora/RHEL:    sudo dnf install p7zip p7zip-plugins"
      echo "    Arch:           sudo pacman -S p7zip"
      echo "    Alpine:         sudo apk add p7zip"
      echo "    macOS:          brew install p7zip"
      echo ""
      echo "  Para .rar: unrar / unar"
      echo "    Debian/Ubuntu:  sudo apt install unrar-free"
      echo "    Fedora/RHEL:    sudo dnf install unar"
      echo "    Arch:           sudo pacman -S unrar"
      echo "    macOS:          brew install unar"
      echo ""
      exit 1
      ;;
  esac

  echo ""
  verify
  echo ""
  info "Listo. Reinicia el servidor del panel para aplicar los cambios."
}

main "$@"
