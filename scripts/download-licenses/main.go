// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// goLicensesVersion is the go-licenses version pinned for the download.
const goLicensesVersion = "v2.0.1"

// licenseFileRe mirrors go-licenses' candidate file pattern, minus README.
var licenseFileRe = regexp.MustCompile(`(?i)^((UN)?LICEN(S|C)E|COPYING|NOTICE).*$`)

var moduleRe = regexp.MustCompile(`(?m)^module\s+(\S+)`)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	root, err := repoRoot()
	if err != nil {
		return err
	}
	if err := os.Chdir(root); err != nil {
		return err
	}

	runCommand := func(name string, args ...string) error {
		cmd := exec.Command(name, args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	if err := runCommand("go", "mod", "download"); err != nil {
		return fmt.Errorf("go mod download: %w", err)
	}

	goMod, err := os.ReadFile("go.mod")
	if err != nil {
		return err
	}
	match := moduleRe.FindSubmatch(goMod)
	if match == nil {
		return fmt.Errorf("could not find the module path in go.mod")
	}
	module := string(match[1])

	tmp, err := os.MkdirTemp("", "dsh-podman-licenses-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	licenseDir := filepath.Join(tmp, "licenses")

	if err := runCommand("go", "run", "github.com/google/go-licenses/v2@"+goLicensesVersion, "save", "./...", "--save_path="+licenseDir, "--ignore", module); err != nil {
		return fmt.Errorf("go-licenses save: %w", err)
	}

	projectLicense, err := os.ReadFile("LICENSE")
	if err != nil {
		return err
	}
	var out strings.Builder
	out.Write(projectLicense)
	out.WriteString("\n---\n\nTHIRD PARTY LICENSES\n")

	perProject := map[string][]string{}
	if err := filepath.WalkDir(licenseDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !licenseFileRe.MatchString(d.Name()) {
			return nil
		}
		rel, err := filepath.Rel(licenseDir, path)
		if err != nil {
			return err
		}
		perProject[filepath.Dir(rel)] = append(perProject[filepath.Dir(rel)], rel)
		return nil
	}); err != nil {
		return err
	}

	projects := make([]string, 0, len(perProject))
	for project := range perProject {
		projects = append(projects, project)
	}
	sort.Strings(projects)
	for _, project := range projects {
		files := perProject[project]
		sort.Strings(files)
		for _, rel := range files {
			data, err := os.ReadFile(filepath.Join(licenseDir, rel))
			if err != nil {
				return err
			}
			label := "License"
			if strings.HasPrefix(strings.ToLower(filepath.Base(rel)), "notice") {
				label = "Notice"
			}
			out.WriteString(fmt.Sprintf("\n---\n\n%s for %s\n\n", label, project))
			out.Write(data)
		}
	}

	if err := os.WriteFile("LICENSE.pkg", []byte(out.String()), 0600); err != nil {
		return err
	}
	return nil
}

// repoRoot returns the repository root, derived from this file's location.
func repoRoot() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("could not determine the caller location")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..")), nil
}
