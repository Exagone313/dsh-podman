// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package ptc

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
)

// requireRoot skips a test that must create and own directories; switching a
// child to another uid needs root with CAP_SETUID/CAP_SETGID, which sandboxes
// and some CI containers lack.
func requireRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("requires root to prepare an owned PTC home")
	}
}

func TestDisabledLeavesIdentityAndEnvironmentAlone(t *testing.T) {
	t.Setenv(ModeEnv, "")
	uid, gid := uint32(7), uint32(8)
	opts := identity.Options{Uid: &uid, Gid: &gid}
	env := map[string]string{"HOME": "/custom", "KEEP": "1"}
	gotOpts, gotEnv, err := Attach(opts, env)
	if err != nil {
		t.Fatal(err)
	}
	if gotOpts.Uid != opts.Uid || gotOpts.Gid != opts.Gid {
		t.Fatalf("identity changed outside PTC mode: %#v", gotOpts)
	}
	if len(gotEnv) != len(env) || gotEnv["HOME"] != "/custom" || gotEnv["KEEP"] != "1" {
		t.Fatalf("environment changed outside PTC mode: %#v", gotEnv)
	}
}

// TestArbitraryUIDGetsOwnedWritableHome pins the PTC child contract: an
// arbitrary requested uid/gid runs with HOME and the XDG directories pointing
// at a directory that uid owns and can write, never the inherited /root.
func TestArbitraryUIDGetsOwnedWritableHome(t *testing.T) {
	requireRoot(t)
	t.Setenv(ModeEnv, "true")
	uid, gid := uint32(23456), uint32(23457)
	opts, env, err := Attach(identity.Options{Uid: &uid, Gid: &gid}, map[string]string{"KEEP": "1"})
	if err != nil {
		t.Fatal(err)
	}
	if opts.EffectiveUid() != uid || opts.EffectiveGid() != gid {
		t.Fatalf("the requested identity was not kept: %#v", opts)
	}
	home := env["HOME"]
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	wantHome := filepath.Join(homeRoot, "23456")
	if home != wantHome {
		t.Fatalf("unexpected HOME %q, want %q", home, wantHome)
	}
	for _, key := range []string{"XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"} {
		path := env[key]
		if path == "" || path == home || !strings.HasPrefix(path, home+"/") {
			t.Fatalf("%s does not point inside the home: %q", key, path)
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			t.Fatalf("%s was not created: %v", key, statErr)
		}
		if !info.IsDir() || info.Mode().Perm() != 0700 {
			t.Fatalf("%s is not a private directory: %v", key, info.Mode())
		}
	}
	info, err := os.Stat(home)
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("no stat data")
	}
	if stat.Uid != uid || stat.Gid != gid {
		t.Fatalf("home owned by %d:%d, want %d:%d", stat.Uid, stat.Gid, uid, gid)
	}
	if info.Mode().Perm() != 0700 {
		t.Fatalf("home mode is %v, want 0700", info.Mode())
	}
	// Every directory on the path must be traversable by the child: the
	// home parent is open, and .local (which holds the XDG data dirs) belongs
	// to the child rather than root.
	parent, err := os.Stat(homeRoot)
	if err != nil {
		t.Fatal(err)
	}
	if parent.Mode().Perm() != 0o777 || parent.Mode()&os.ModeSticky == 0 {
		t.Fatalf("PTC home parent mode is %v, want 01777", parent.Mode())
	}
	local, err := os.Stat(filepath.Join(home, ".local"))
	if err != nil {
		t.Fatal(err)
	}
	localStat := local.Sys().(*syscall.Stat_t)
	if localStat.Uid != uid || local.Mode().Perm() != 0700 {
		t.Fatalf(".local owned by %d mode %v, want %d mode 0700", localStat.Uid, local.Mode(), uid)
	}
	// The agent appends the PTC environment to the inherited one, so the child
	// sees the writable home rather than the agent's own /root.
	t.Setenv("HOME", "/root")
	built := childenv.Build(childenv.NewPaths(), env)
	if !slices.Contains(built, "HOME="+home) {
		t.Fatalf("the child environment does not carry the PTC home: %q", built)
	}
}

// TestExistingHomeOwnedByAnotherUserIsRepaired pins the recovery path: a home
// left by an earlier run, or created by root, is chowned and restricted to the
// target identity instead of failing the child's start.
func TestExistingHomeOwnedByAnotherUserIsRepaired(t *testing.T) {
	requireRoot(t)
	const otherUid, otherGid = 34567, 34568
	uid, gid := uint32(23456), uint32(23457)
	parent := t.TempDir()
	home := filepath.Join(parent, strconv.FormatUint(uint64(uid), 10))
	for _, directory := range homeDirectories(home) {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(directory, otherUid, otherGid); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got, err := prepareHomeAt(parent, uid, gid)
	if err != nil {
		t.Fatal(err)
	}
	if got != home {
		t.Fatalf("unexpected home %q, want %q", got, home)
	}
	for _, directory := range homeDirectories(home) {
		info, err := os.Stat(directory)
		if err != nil {
			t.Fatal(err)
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Uid != uid || stat.Gid != gid {
			t.Fatalf("%q owned by %d:%d, want %d:%d", directory, stat.Uid, stat.Gid, uid, gid)
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("%q mode is %v, want 0700", directory, info.Mode())
		}
	}
}

// TestMissingHomeIsCreated pins that a fresh container's absent home chain is
// created for the requested identity, not only repaired after the fact.
func TestMissingHomeIsCreated(t *testing.T) {
	requireRoot(t)
	uid, gid := uint32(23456), uint32(23457)
	parent := t.TempDir()
	home, err := prepareHomeAt(parent, uid, gid)
	if err != nil {
		t.Fatal(err)
	}
	if home != filepath.Join(parent, "23456") {
		t.Fatalf("unexpected home %q", home)
	}
	for _, directory := range homeDirectories(home) {
		info, err := os.Stat(directory)
		if err != nil {
			t.Fatal(err)
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Uid != uid || stat.Gid != gid {
			t.Fatalf("%q owned by %d:%d, want %d:%d", directory, stat.Uid, stat.Gid, uid, gid)
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("%q mode is %v, want 0700", directory, info.Mode())
		}
	}
}

// TestUnrepairableHomeFailsWithTheReason pins the only fatal case: a path that
// cannot become the child's home reports what could not be fixed.
func TestUnrepairableHomeFailsWithTheReason(t *testing.T) {
	requireRoot(t)
	uid, gid := uint32(23456), uint32(23457)
	parent := t.TempDir()
	home := filepath.Join(parent, strconv.FormatUint(uint64(uid), 10))
	if err := os.WriteFile(home, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := prepareHomeAt(parent, uid, gid)
	if err == nil {
		t.Fatal("expected the unrepairable home to fail")
	}
	for _, want := range []string{"repair PTC home", home, "not a directory"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not mention %q", err, want)
		}
	}
}

func TestDefaultIdentityIsNumeric(t *testing.T) {
	requireRoot(t)
	t.Setenv(ModeEnv, "true")
	uid := uint32(DefaultUID)
	opts, env, err := Attach(identity.Options{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(env["HOME"]) })
	if opts.EffectiveUid() != DefaultUID || opts.EffectiveGid() != DefaultGID {
		t.Fatalf("unexpected default PTC identity: %#v", opts)
	}
	if env["HOME"] != filepath.Join(homeRoot, "65534") {
		t.Fatalf("unexpected default PTC home: %q", env["HOME"])
	}
	info, err := os.Stat(env["HOME"])
	if err != nil {
		t.Fatal(err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	if stat.Uid != uid || stat.Gid != DefaultGID {
		t.Fatalf("default home owned by %d:%d, want %d:%d", stat.Uid, stat.Gid, uid, DefaultGID)
	}
}

func TestHomeEnvPointsInsideHome(t *testing.T) {
	home := "/tmp/example/home"
	env := HomeEnv(home)
	if env["HOME"] != home {
		t.Fatalf("unexpected HOME: %q", env["HOME"])
	}
	for key, value := range env {
		if key == "HOME" {
			continue
		}
		if !strings.HasPrefix(value, home+"/") {
			t.Fatalf("%s does not point inside HOME: %q", key, value)
		}
	}
}
