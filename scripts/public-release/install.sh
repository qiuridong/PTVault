#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
  printf '%s\n' '请用 sudo sh scripts/public-release/install.sh 运行安装器。' >&2
  exit 1
fi
if [ ! -x /usr/bin/python3 ]; then
  for arg do
    if [ "$arg" = '--no-install-deps' ]; then
      printf '%s\n' 'Python 3 尚未安装；按 --no-install-deps 要求未安装依赖。' >&2
      exit 1
    fi
  done
  if ! grep -Eq '^ID="?ubuntu"?$' /etc/os-release || ! grep -Eq '^VERSION_ID="?24\.04"?$' /etc/os-release; then
    printf '%s\n' '当前发行仅支持 Ubuntu 24.04 x86-64。' >&2
    exit 1
  fi
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l /usr/bin/apt-get update
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l /usr/bin/apt-get install -y --no-remove --no-install-recommends python3
fi
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /usr/bin/python3 -B "$HERE/install.py" install --release "$HERE/../.." "$@"
