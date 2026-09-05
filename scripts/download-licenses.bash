#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
#
# SPDX-License-Identifier: MIT

set -eo pipefail
shopt -s globstar

cd "$(dirname "$0")/.."

go mod download

tmpdir="$(mktemp -d)"
at_exit() {
	rm -rf "${tmpdir}"
}
trap at_exit EXIT

license_dir="${tmpdir}/licenses"

module="$(grep '^module' go.mod | sed 's/^module //')"
go run github.com/google/go-licenses/v2@v2.0.1 save ./... --save_path="${license_dir}" --ignore "${module}"

exec > LICENSE.pkg

cat LICENSE

echo -e "\n\n---\n\nTHIRD PARTY LICENSES"

for f in "${license_dir}"/**/LICENSE; do
	if [ -f "${f}" ]; then
		name="${f#"${license_dir}/"}"
		name="${name%/LICENSE}"
		echo -e "\n---\n\nLicense for ${name}\n"
		cat "${f}"
	fi
done
