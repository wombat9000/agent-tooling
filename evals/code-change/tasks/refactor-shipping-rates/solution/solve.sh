#!/usr/bin/env bash
set -eu

solution="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cp -R "$solution/reference/." "${WORKSPACE_DIR:-/workspace}/"
