// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// cacheManagers lists the package managers whose build caches the orchestrator
// manages, in listing order.
var cacheManagers = []string{"pacman", "apt", "apk"}

// CacheCleanMode selects how much a cache cleanup removes.
type CacheCleanMode string

const (
	// CacheKeepLatest keeps the newest cached file of every package and removes
	// that package's older duplicates together with the signatures they
	// carried. Every other file — repository indices and other metadata — is
	// left untouched.
	CacheKeepLatest CacheCleanMode = "keep-latest"
	// CacheRemoveAll empties every configured cache directory, leaving the
	// directory (and any mount point) itself in place.
	CacheRemoveAll CacheCleanMode = "all"
)

// CacheStat reports one package manager's configured build cache.
type CacheStat struct {
	Manager string
	Path    string
	Files   int
	Bytes   int64
}

// CacheCleanResult reports one cleanup run.
type CacheCleanResult struct {
	Mode   CacheCleanMode
	Files  int
	Bytes  int64
	Caches []CacheStat
}

// CacheStats reports the size of every configured build cache. It takes the
// read lock, so it can report while a build is running.
func (b *Builder) CacheStats() ([]CacheStat, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	stats := make([]CacheStat, 0, len(cacheManagers))
	for _, manager := range cacheManagers {
		dir, _, configured := b.cacheMount(manager)
		if !configured {
			continue
		}
		files, bytes, err := cacheDirSize(dir)
		if err != nil {
			return nil, fmt.Errorf("%s cache %q: %w", manager, dir, err)
		}
		stats = append(stats, CacheStat{Manager: manager, Path: dir, Files: files, Bytes: bytes})
	}
	return stats, nil
}

// CleanCaches removes cached package files according to mode. It takes the
// write lock, so it never runs while a build is using the caches.
func (b *Builder) CleanCaches(mode CacheCleanMode) (CacheCleanResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if mode != CacheKeepLatest && mode != CacheRemoveAll {
		return CacheCleanResult{}, fmt.Errorf("unknown cache clean mode %q", mode)
	}
	result := CacheCleanResult{Mode: mode}
	for _, manager := range cacheManagers {
		dir, _, configured := b.cacheMount(manager)
		if !configured {
			continue
		}
		beforeFiles, beforeBytes, err := cacheDirSize(dir)
		if err != nil {
			return CacheCleanResult{}, fmt.Errorf("%s cache %q: %w", manager, dir, err)
		}
		if mode == CacheKeepLatest {
			err = cleanKeepLatest(manager, dir)
		} else {
			err = cleanRemoveAll(dir)
		}
		if err != nil {
			return CacheCleanResult{}, fmt.Errorf("%s cache %q: %w", manager, dir, err)
		}
		afterFiles, afterBytes, err := cacheDirSize(dir)
		if err != nil {
			return CacheCleanResult{}, fmt.Errorf("%s cache %q: %w", manager, dir, err)
		}
		result.Files += beforeFiles - afterFiles
		result.Bytes += beforeBytes - afterBytes
		result.Caches = append(result.Caches, CacheStat{Manager: manager, Path: dir, Files: afterFiles, Bytes: afterBytes})
	}
	return result, nil
}

// cacheRoot resolves a configured cache directory. Only the directory itself is
// followed (a deployment may point at a symlink, as apk does with
// /etc/apk/cache); nothing inside it ever is. A missing directory reads as
// absent, not as an error.
func cacheRoot(dir string) (string, bool, error) {
	resolved, err := filepath.EvalSymlinks(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return resolved, true, nil
}

// cacheDirSize sums the regular files under dir. Directories and symlinks are
// skipped, so a link out of the cache neither inflates the size nor gets
// walked.
func cacheDirSize(dir string) (int, int64, error) {
	root, ok, err := cacheRoot(dir)
	if err != nil || !ok {
		return 0, 0, err
	}
	files := 0
	var bytes int64
	err = filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		files++
		bytes += info.Size()
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	return files, bytes, nil
}

// cleanRemoveAll empties dir, leaving the directory itself in place. os.RemoveAll
// unlinks a symlink instead of following it, and WalkDir never descends into a
// symlinked directory.
func cleanRemoveAll(dir string) error {
	root, ok, err := cacheRoot(dir)
	if err != nil || !ok {
		return err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(root, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

// cleanKeepLatest removes every cached package file except the newest one of
// each package (by modification time) in each directory, dropping the removed
// packages' signatures with them. Files that are not package files or
// signatures — repository indices and other metadata — are left untouched, and
// symlinks are neither followed nor removed.
func cleanKeepLatest(manager, dir string) error {
	root, ok, err := cacheRoot(dir)
	if err != nil || !ok {
		return err
	}
	packages := make(map[string]time.Time) // package path -> modification time
	groups := make(map[string]string)      // group key -> newest package path so far
	signatures := make(map[string]string)  // signature path -> package path
	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		if target, ok := signatureTarget(manager, path); ok {
			signatures[path] = target
			return nil
		}
		group, ok := packageGroup(manager, path)
		if !ok {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		packages[path] = info.ModTime()
		if newest, seen := groups[group]; !seen || info.ModTime().After(packages[newest]) {
			groups[group] = path
		}
		return nil
	})
	if walkErr != nil {
		return walkErr
	}
	keep := make(map[string]bool, len(groups))
	for _, newest := range groups {
		keep[newest] = true
	}
	for path := range packages {
		if keep[path] {
			continue
		}
		if err := removeFile(path); err != nil {
			return err
		}
	}
	for signature, target := range signatures {
		// A signature is kept only while its package is, so an orphaned one (its
		// package already gone) is removed too.
		if keep[target] {
			continue
		}
		if err := removeFile(signature); err != nil {
			return err
		}
	}
	return nil
}

// removeFile deletes one cache file, tolerating one already gone.
func removeFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// pacmanPackage matches <name>-<version>-<release>-<arch>.pkg.tar.<ext>. Package
// names may contain hyphens, so the three trailing fields are matched from the
// right.
var pacmanPackage = regexp.MustCompile(`^(.+)-([^-]+)-([^-]+)-([^-]+)\.pkg\.tar\.(?:zst|xz|gz|bz2|Z)$`)

// pacmanSignature matches a pacman package signature file.
var pacmanSignature = regexp.MustCompile(`^.*\.pkg\.tar\.(?:zst|xz|gz|bz2|Z)\.sig$`)

// apkPackage matches <name>-<version>-r<release>.apk.
var apkPackage = regexp.MustCompile(`^(.+)-[^-]+-r\d+\.apk$`)

// packageGroup returns the grouping key for a package file: its directory plus
// the package's name and, where the manager keeps it in the filename, its
// architecture. Versions of one package for one platform therefore group
// together, while different packages, repositories, and architectures do not.
// ok is false for files that are not package files.
func packageGroup(manager, path string) (string, bool) {
	dir := filepath.Dir(path)
	filename := filepath.Base(path)
	switch manager {
	case "pacman":
		// 1=name, 2=version, 3=release, 4=architecture.
		match := pacmanPackage.FindStringSubmatch(filename)
		if match == nil {
			return "", false
		}
		return dir + "\x00" + match[1] + "\x00" + match[4], true
	case "apt":
		if !strings.HasSuffix(filename, ".deb") {
			return "", false
		}
		// <name>_<version>_<arch>.deb: neither a Debian package name nor a
		// Debian version contains an underscore.
		fields := strings.SplitN(strings.TrimSuffix(filename, ".deb"), "_", 3)
		if len(fields) != 3 || fields[0] == "" {
			return "", false
		}
		return dir + "\x00" + fields[0] + "\x00" + fields[2], true
	case "apk":
		// The apk cache keeps the architecture in the path, so the directory
		// already separates it.
		match := apkPackage.FindStringSubmatch(filename)
		if match == nil {
			return "", false
		}
		return dir + "\x00" + match[1], true
	}
	return "", false
}

// signatureTarget returns the package file a signature belongs to, or ok=false
// when the file is not a package signature. Only pacman keeps per-package
// signatures in its cache.
func signatureTarget(manager, path string) (string, bool) {
	if manager != "pacman" {
		return "", false
	}
	if !pacmanSignature.MatchString(filepath.Base(path)) {
		return "", false
	}
	return strings.TrimSuffix(path, ".sig"), true
}
