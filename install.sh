#!/usr/bin/env sh
# AgentOps Workbench installer: downloads the standalone `agentops` binary for
# your platform from the latest GitHub release and installs it. No Bun, no clone.
#
#   curl -fsSL https://raw.githubusercontent.com/DevenDucommun/agentops-workbench/main/install.sh | sh
#
# Env overrides:
#   AGENTOPS_INSTALL_DIR  install directory (default: /usr/local/bin)
#   AGENTOPS_VERSION      release tag to install (default: latest)
set -eu

REPO="DevenDucommun/agentops-workbench"
INSTALL_DIR="${AGENTOPS_INSTALL_DIR:-/usr/local/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin | linux) ;;
  *) echo "Unsupported OS: $os (supported: macOS, Linux)" >&2; exit 1 ;;
esac
asset="agentops-${os}-${arch}"

tag="${AGENTOPS_VERSION:-}"
if [ -z "$tag" ]; then
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
fi
if [ -z "$tag" ]; then
  echo "Could not determine the latest release tag for ${REPO}." >&2
  exit 1
fi

url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
tmp="$(mktemp)"
echo "Downloading ${asset} (${tag})..."
curl -fSL "$url" -o "$tmp"
chmod +x "$tmp"

echo "Installing to ${INSTALL_DIR}/agentops"
if [ -w "$INSTALL_DIR" ]; then
  mv "$tmp" "${INSTALL_DIR}/agentops"
else
  sudo mv "$tmp" "${INSTALL_DIR}/agentops"
fi

echo "Installed. Run: agentops --help"
