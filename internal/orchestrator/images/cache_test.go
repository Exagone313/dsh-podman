// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"
	"time"
)

var (
	oldTime = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	newTime = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
)

// fixture is one cache file to create, stamped so "keep the newest" is
// deterministic.
type fixture struct {
	name string
	at   time.Time
}

func cacheFixture(t *testing.T, dir string, files ...fixture) {
	t.Helper()
	for _, file := range files {
		path := filepath.Join(dir, file.name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(file.name), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, file.at, file.at); err != nil {
			t.Fatal(err)
		}
	}
}

// cacheTree lists the relative paths left under dir, sorted. Symlinks are
// listed as themselves and never descended.
func cacheTree(t *testing.T, dir string) []string {
	t.Helper()
	var paths []string
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return relErr
		}
		paths = append(paths, rel)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(paths)
	return paths
}

func TestCacheStats(t *testing.T) {
	pacmanDir := t.TempDir()
	aptDir := t.TempDir()
	cacheFixture(t, pacmanDir,
		fixture{name: "busybox-1.37.0-1-x86_64.pkg.tar.zst", at: newTime},
		fixture{name: "busybox-1.37.0-1-x86_64.pkg.tar.zst.sig", at: newTime},
	)
	cacheFixture(t, aptDir, fixture{name: "jq_1.7.1-3build1_amd64.deb", at: newTime})
	// A symlink is neither counted nor followed.
	if err := os.Symlink("/etc/hostname", filepath.Join(pacmanDir, "linked.pkg.tar.zst")); err != nil {
		t.Fatal(err)
	}
	stats, err := (&Builder{HostPacmanCache: pacmanDir, HostAptCache: aptDir}).CacheStats()
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 2 {
		t.Fatalf("expected the two configured caches, got %#v", stats)
	}
	if stats[0].Manager != "pacman" || stats[0].Path != pacmanDir || stats[0].Files != 2 || stats[0].Bytes <= 0 {
		t.Fatalf("unexpected pacman stats: %#v", stats[0])
	}
	if stats[1].Manager != "apt" || stats[1].Files != 1 || stats[1].Bytes <= 0 {
		t.Fatalf("unexpected apt stats: %#v", stats[1])
	}
}

func TestCacheStatsWithoutConfiguredCaches(t *testing.T) {
	stats, err := (&Builder{}).CacheStats()
	if err != nil || len(stats) != 0 {
		t.Fatalf("expected no caches, got %#v, %v", stats, err)
	}
}

func TestCacheStatsMissingDirectoryReadsEmpty(t *testing.T) {
	builder := &Builder{HostPacmanCache: filepath.Join(t.TempDir(), "missing")}
	stats, err := builder.CacheStats()
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 || stats[0].Files != 0 || stats[0].Bytes != 0 {
		t.Fatalf("expected an empty cache, got %#v", stats)
	}
}

// TestCacheStatsFollowsConfiguredSymlink covers apk, whose cache path is
// conventionally a symlink: the configured directory itself resolves, while
// nothing inside it is followed.
func TestCacheStatsFollowsConfiguredSymlink(t *testing.T) {
	real := t.TempDir()
	cacheFixture(t, real, fixture{name: "main/x86_64/busybox-1.37.0-r1.apk", at: newTime})
	link := filepath.Join(t.TempDir(), "apk-cache")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	stats, err := (&Builder{HostApkCache: link}).CacheStats()
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 || stats[0].Files != 1 {
		t.Fatalf("expected the configured symlink to resolve, got %#v", stats)
	}
}

func TestCleanCachesKeepLatest(t *testing.T) {
	cases := []struct {
		manager string
		files   []fixture
		want    []string
	}{
		{
			manager: "pacman",
			files: []fixture{
				{name: "busybox-1.36.1-1-x86_64.pkg.tar.zst", at: oldTime},
				{name: "busybox-1.36.1-1-x86_64.pkg.tar.zst.sig", at: oldTime},
				{name: "busybox-1.37.0-1-x86_64.pkg.tar.zst", at: newTime},
				{name: "busybox-1.37.0-1-x86_64.pkg.tar.zst.sig", at: newTime},
				{name: "ca-certificates-20240618-1-any.pkg.tar.zst", at: oldTime},
				{name: "orphan-1.0-1-any.pkg.tar.zst.sig", at: oldTime},
				{name: "some-index.db", at: oldTime},
			},
			want: []string{
				"busybox-1.37.0-1-x86_64.pkg.tar.zst",
				"busybox-1.37.0-1-x86_64.pkg.tar.zst.sig",
				"ca-certificates-20240618-1-any.pkg.tar.zst",
				"some-index.db",
			},
		},
		{
			manager: "apt",
			files: []fixture{
				{name: "jq_1.7.1-3build1_amd64.deb", at: oldTime},
				{name: "jq_1.7.1-3build1ubuntu1_amd64.deb", at: newTime},
				// A different architecture is a different group, so its own
				// (only) build is kept.
				{name: "jq_1.7.1-3build1_arm64.deb", at: oldTime},
				{name: "curl_8.5.0-2ubuntu10.6_amd64.deb", at: oldTime},
				// Not a package file.
				{name: "lock", at: oldTime},
			},
			want: []string{
				"curl_8.5.0-2ubuntu10.6_amd64.deb",
				"jq_1.7.1-3build1_arm64.deb",
				"jq_1.7.1-3build1ubuntu1_amd64.deb",
				"lock",
			},
		},
		{
			manager: "apk",
			files: []fixture{
				{name: "main/x86_64/busybox-1.36.1-r31.apk", at: oldTime},
				{name: "main/x86_64/busybox-1.37.0-r1.apk", at: newTime},
				{name: "main/x86_64/ca-certificates-20241121-r1.apk", at: oldTime},
				// The repository directory separates groups.
				{name: "community/x86_64/busybox-1.36.1-r31.apk", at: oldTime},
				// The repository index is not a package.
				{name: "main/x86_64/APKINDEX.tar.gz", at: oldTime},
			},
			want: []string{
				"community/x86_64/busybox-1.36.1-r31.apk",
				"main/x86_64/APKINDEX.tar.gz",
				"main/x86_64/busybox-1.37.0-r1.apk",
				"main/x86_64/ca-certificates-20241121-r1.apk",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.manager, func(t *testing.T) {
			dir := t.TempDir()
			cacheFixture(t, dir, tc.files...)
			builder := builderFor(t, tc.manager, dir)
			result, err := builder.CleanCaches(CacheKeepLatest)
			if err != nil {
				t.Fatal(err)
			}
			if result.Mode != CacheKeepLatest {
				t.Fatalf("unexpected mode %q", result.Mode)
			}
			if got := cacheTree(t, dir); !slices.Equal(got, tc.want) {
				t.Fatalf("kept %#v, want %#v", got, tc.want)
			}
			if len(result.Caches) != 1 || result.Caches[0].Files != len(tc.want) {
				t.Fatalf("unexpected result caches: %#v", result.Caches)
			}
			if result.Files != len(tc.files)-len(tc.want) {
				t.Fatalf("removed %d files, want %d", result.Files, len(tc.files)-len(tc.want))
			}
			if result.Bytes <= 0 {
				t.Fatalf("expected a positive byte count, got %d", result.Bytes)
			}
		})
	}
}

func TestCleanCachesRemoveAll(t *testing.T) {
	pacmanDir := t.TempDir()
	aptDir := t.TempDir()
	cacheFixture(t, pacmanDir,
		fixture{name: "busybox-1.37.0-1-x86_64.pkg.tar.zst", at: newTime},
		fixture{name: "some-index.db", at: newTime},
	)
	cacheFixture(t, aptDir, fixture{name: "partial/jq_1.7.1-3build1_amd64.deb", at: newTime})
	builder := &Builder{HostPacmanCache: pacmanDir, HostAptCache: aptDir}
	result, err := builder.CleanCaches(CacheRemoveAll)
	if err != nil {
		t.Fatal(err)
	}
	if result.Mode != CacheRemoveAll || result.Files != 3 || result.Bytes <= 0 {
		t.Fatalf("unexpected result: %#v", result)
	}
	for _, dir := range []string{pacmanDir, aptDir} {
		if got := cacheTree(t, dir); len(got) != 0 {
			t.Fatalf("expected %s to be emptied, got %#v", dir, got)
		}
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("the cache directory itself must survive: %v", err)
		}
	}
	if len(result.Caches) != 2 || result.Caches[0].Files != 0 || result.Caches[0].Bytes != 0 {
		t.Fatalf("unexpected caches after cleanup: %#v", result.Caches)
	}
}

// TestCleanCachesDoesNotFollowSymlinks covers the guard: neither mode follows a
// symlink, so a symlinked directory's target is never emptied and a symlinked
// file's target is never deleted. keep-latest leaves the links themselves alone
// (they are not package files), while remove-all unlinks them as part of
// emptying the cache.
func TestCleanCachesDoesNotFollowSymlinks(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(outsideFile, []byte("keep"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "linked-dir")); err != nil {
		t.Fatal(err)
	}
	cacheFixture(t, dir, fixture{name: "busybox-1.37.0-1-x86_64.pkg.tar.zst", at: newTime})
	if err := os.Symlink(outsideFile, filepath.Join(dir, "linked.pkg.tar.zst")); err != nil {
		t.Fatal(err)
	}
	// keep-latest only ever removes package files, so it leaves both links.
	if _, err := (&Builder{HostPacmanCache: dir}).CleanCaches(CacheKeepLatest); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"linked-dir", "linked.pkg.tar.zst"} {
		if got := cacheTree(t, dir); !slices.Contains(got, name) {
			t.Fatalf("keep-latest removed %s: %#v", name, got)
		}
	}
	// remove-all unlinks the entries themselves, but never what they point at.
	if _, err := (&Builder{HostPacmanCache: dir}).CleanCaches(CacheRemoveAll); err != nil {
		t.Fatal(err)
	}
	if got := cacheTree(t, dir); len(got) != 0 {
		t.Fatalf("expected the cache to be emptied, got %#v", got)
	}
	if _, err := os.Stat(outsideFile); err != nil {
		t.Fatalf("a file outside the cache was touched: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("a directory outside the cache was removed: %v", err)
	}
}

func TestCleanCachesRejectsUnknownMode(t *testing.T) {
	builder := &Builder{HostPacmanCache: t.TempDir()}
	if _, err := builder.CleanCaches("nope"); err == nil {
		t.Fatal("expected an error for an unknown mode")
	}
}

// builderFor points one manager's cache at dir.
func builderFor(t *testing.T, manager, dir string) *Builder {
	t.Helper()
	builder := &Builder{}
	switch manager {
	case "pacman":
		builder.HostPacmanCache = dir
	case "apt":
		builder.HostAptCache = dir
	case "apk":
		builder.HostApkCache = dir
	default:
		t.Fatalf("unknown manager %q", manager)
	}
	return builder
}
