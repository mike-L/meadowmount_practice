#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install it from https://www.python.org/downloads/ and try again."
  read -r "?Press Return to close..."
  exit 1
fi
python3 server.py
