// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package socket

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestListenRestrictsTheSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run", "guest.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0600 {
		t.Errorf("socket mode is %04o, want 0600", mode)
	}
	dir, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if mode := dir.Mode().Perm(); mode != 0700 {
		t.Errorf("socket directory mode is %04o, want 0700", mode)
	}
}

// TestListenReplacesStaleSocket covers a restart: the socket left behind by
// the previous run must not stop the new one from binding.
func TestListenReplacesStaleSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "guest.sock")
	first, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	// Leave the socket behind on close, the way a crash would.
	first.(*net.UnixListener).SetUnlinkOnClose(false)
	first.Close()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stale socket was not left behind: %v", err)
	}
	listener, err := Listen(path)
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	listener.Close()
}

// TestListenReportsAnUnusablePath covers a path that cannot be replaced, so
// the caller fails loudly instead of serving on nothing.
func TestListenReportsAnUnusablePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "guest.sock")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "occupied"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(path); err == nil {
		t.Fatal("expected an error for a non-empty directory in the socket's place")
	}
}
