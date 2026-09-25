#!/bin/sh
set -eu
plugin_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
QWEN_CODE_SYSTEM_DEFAULTS_PATH=$(node "$plugin_dir/card-settings.cjs" "$plugin_dir")
export QWEN_CODE_SYSTEM_DEFAULTS_PATH
exec qwen "$@"
