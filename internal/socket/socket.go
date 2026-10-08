// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package socket creates the unix sockets the orchestrator and the guest
// agents listen on, with permissions that keep them reachable only by the
// user running them.
package socket

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

// Restrict sets a 0077 creation mask for the private window in which a
// listening socket is created.
//
// bind(2) applies the process mask when it creates the socket, and the chmod
// that follows is a separate step, so without a restrictive mask the socket is
// briefly reachable by other users on the host. A caller that goes on to run
// commands restores the conventional mask with [Relax] once the socket exists.
func Restrict() {
	syscall.Umask(0o077)
}

// Relax restores the conventional 0022 creation mask, so files a process
// creates afterwards are 0644 and directories 0755.
func Relax() {
	syscall.Umask(0o022)
}

// Listen creates the parent directory of path if needed, replaces a stale
// socket left by a previous run, and listens on it with mode 0600.
func Listen(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

// RequirePrivateDir checks that dir exists, is a directory, and is reachable
// only by its owner. A socket created 0600 is still exposed when the directory
// above it can be traversed by other users, so every component that hosts a
// control or data socket in a shared root verifies this before listening.
func RequirePrivateDir(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("socket root %q is not accessible: %w", dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("socket root %q is not a directory", dir)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return fmt.Errorf("socket root %q is group- or world-accessible (mode %04o); it must be 0700", dir, mode)
	}
	return nil
}
