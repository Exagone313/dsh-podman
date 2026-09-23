#!/bin/sh
# SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
#
# SPDX-License-Identifier: MIT

# Install the dsh-podman plugin this image was built for, then start dsh.
#
# The plugin and the orchestrator must share a major version, and the
# orchestrator refuses a plugin from another major, so the profile's plugin is
# kept at exactly the version baked into the image — upgrades and downgrades
# alike. The install is online.
#
# DSH_PODMAN_PLUGIN_SOURCE points at a bind-mounted package for local
# development: either a directory that holds package.json and its npm-pack
# archive, or the archive itself. It is installed as-is and never falls back to
# the registry; a missing package is an error.
set -eu

: "${DSH_HOME:=${HOME:-/root}/.dsh}"
profile="$DSH_HOME/profiles/web"
installed_manifest="$profile/node_modules/@exagone313/dsh-podman/package.json"

source="${DSH_PODMAN_PLUGIN_SOURCE:-}"
if [ -z "$source" ] && [ -z "${DSH_PODMAN_PLUGIN_VERSION:-}" ]; then
  printf 'error: this dsh image was built without DSH_PODMAN_PLUGIN_VERSION\n' >&2
  exit 1
fi

# The plugin's installed version, and the spec the profile records for it.
# Both branches below compare against them; the dev branch only needs to know
# whether the plugin is a declared dependency at all.
installed=""
if [ -f "$installed_manifest" ]; then
  installed=$(node -p "require('$installed_manifest').version")
fi
declared=""
if [ -f "$profile/package.json" ]; then
  declared=$(node -p "require('$profile/package.json').dependencies?.['@exagone313/dsh-podman'] || ''")
fi

if [ -n "$source" ]; then
  if [ -d "$source" ]; then
    if [ ! -f "$source/package.json" ]; then
      printf 'error: %s has no package.json\n' "$source" >&2
      exit 1
    fi
    version=$(node -p "require('$source/package.json').version")
    stem=$(node -p "require('$source/package.json').name.replace('@','').replace('/','-')")
    spec="$source/$stem-$version.tgz"
    if [ ! -f "$spec" ]; then
      printf 'error: %s not found; run npm pack in %s\n' "$spec" "$source" >&2
      exit 1
    fi
  elif [ -f "$source" ]; then
    spec="$source"
  else
    printf 'error: DSH_PODMAN_PLUGIN_SOURCE=%s does not exist\n' "$source" >&2
    exit 1
  fi
  # pnpm reuses the recorded resolution for an unchanged spec, so a rebuilt
  # tarball at the same version would never be extracted. Removing the plugin
  # first forces a real install. A profile that never had it is left alone:
  # removing an undeclared dependency would fail.
  if [ -n "$declared" ]; then
    printf 'dsh-podman: uninstalling @exagone313/dsh-podman\n'
    if ! dsh plugin --profile web remove @exagone313/dsh-podman; then
      printf 'error: cannot remove the installed plugin\n' >&2
      exit 1
    fi
  fi
  printf 'dsh-podman: installing %s\n' "$spec"
  if ! dsh plugin --profile web add "$spec" --save-exact --allow-build=protobufjs; then
    printf 'error: cannot install %s\n' "$spec" >&2
    exit 1
  fi
else
  if [ "$installed" != "$DSH_PODMAN_PLUGIN_VERSION" ] || [ "$declared" != "$DSH_PODMAN_PLUGIN_VERSION" ]; then
    printf 'dsh-podman: installing @exagone313/dsh-podman@%s\n' "$DSH_PODMAN_PLUGIN_VERSION"
    if ! dsh plugin --profile web add "@exagone313/dsh-podman@$DSH_PODMAN_PLUGIN_VERSION" --save-exact --allow-build=protobufjs; then
      printf 'error: cannot install @exagone313/dsh-podman@%s; wait if it was just released, or downgrade both the dsh and orchestrator images\n' \
        "$DSH_PODMAN_PLUGIN_VERSION" >&2
      exit 1
    fi
  fi
fi

exec "$@"
