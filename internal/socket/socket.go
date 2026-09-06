// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package socket creates the unix sockets the orchestrator and the guest
// agents listen on, with permissions that keep them reachable only by the
// user running them.
package socket

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

// Restrict sets a umask that keeps everything the process creates private to
// its owner.
//
// It must run before anything creates a file, because the umask is
// process-wide state and is applied at creation time. It matters most for the
// listening socket: bind(2) creates it with 0777 &^ umask, and the chmod that
// follows is a separate step, so without a restrictive umask the socket is
// briefly reachable by other users on the host.
func Restrict() {
	syscall.Umask(0o077)
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
