// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package publish listens on Unix sockets inside a container's socket directory
// and forwards every connection to a port in the pod's network namespace. The
// gateway reaches those sockets through the shared socket root; a pod port is
// not reachable from the host any other way.
package publish

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/proxy"
	socketpkg "github.com/Exagone313/dsh-podman/internal/socket"
)

// maxPublished bounds how many ports one container can publish, so a loop in a
// guest cannot exhaust the host's descriptors or ports.
const maxPublished = 32

// maxUnixPath is the longest path listen(2) accepts on Linux. The socket path
// is short on purpose: the directory already carries the container's podman
// name, so a long file name would overflow it.
const maxUnixPath = 107

// publishedName matches the deterministic socket names this package creates
// ("t8080"), so a sweep never touches the guest agent's own socket.
var publishedName = regexp.MustCompile(`^[a-z][0-9]{1,5}$`)

// InvalidError marks a caller error — an unsupported protocol, an out-of-range
// port, an unrepresentable name — as opposed to a local failure to listen.
type InvalidError struct{ Err error }

func (e InvalidError) Error() string { return e.Err.Error() }
func (e InvalidError) Unwrap() error { return e.Err }

func invalid(format string, args ...any) error {
	return InvalidError{Err: fmt.Errorf(format, args...)}
}

type key struct {
	protocol guest.Protocol
	port     uint32
}

type entry struct {
	name     string
	listener net.Listener
}

// Manager owns the published sockets of one container.
type Manager struct {
	// Dir is the container's socket directory, shared with the orchestrator
	// and the gateway.
	Dir string
	// DialTimeout bounds connecting to the pod port. Zero means 5s.
	DialTimeout time.Duration
	Logger      *slog.Logger

	mu      sync.Mutex
	entries map[key]entry
}

// New returns a manager for the socket directory dir.
func New(dir string) *Manager {
	return &Manager{Dir: dir}
}

func (m *Manager) log() *slog.Logger {
	if m.Logger != nil {
		return m.Logger
	}
	return slog.Default()
}

func (m *Manager) dialTimeout() time.Duration {
	if m.DialTimeout > 0 {
		return m.DialTimeout
	}
	return 5 * time.Second
}

// socketFileName returns the deterministic name for a protocol and port, so a
// re-publish after a container recreate lands on the same path and the
// gateway's binding keeps working.
func socketFileName(protocol guest.Protocol, port uint32) (string, error) {
	switch protocol {
	case guest.Protocol_PROTOCOL_TCP:
		return "t" + strconv.FormatUint(uint64(port), 10), nil
	default:
		return "", invalid("protocol %s is not supported yet; only tcp is", protocol)
	}
}

// Publish forwards a pod port over a Unix socket and returns the socket file
// name. Publishing the same port twice returns the same name.
func (m *Manager) Publish(protocol guest.Protocol, port uint32) (string, error) {
	if port == 0 || port > 65535 {
		return "", invalid("port %d is outside 1..65535", port)
	}
	socketName, err := socketFileName(protocol, port)
	if err != nil {
		return "", err
	}
	k := key{protocol: protocol, port: port}
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.entries[k]; ok {
		return existing.name, nil
	}
	if len(m.entries) >= maxPublished {
		return "", invalid("at most %d ports can be published", maxPublished)
	}
	target := filepath.Join(m.Dir, socketName)
	if len(target) > maxUnixPath {
		return "", invalid("socket path %q is %d bytes, over the %d-byte limit", target, len(target), maxUnixPath)
	}
	listener, err := socketpkg.Listen(target)
	if err != nil {
		return "", fmt.Errorf("listen on %s: %w", target, err)
	}
	if m.entries == nil {
		m.entries = map[key]entry{}
	}
	m.entries[k] = entry{name: socketName, listener: listener}
	podAddress := net.JoinHostPort("127.0.0.1", strconv.FormatUint(uint64(port), 10))
	go proxy.Serve(listener, func() (net.Conn, error) {
		dialer := net.Dialer{Timeout: m.dialTimeout()}
		return dialer.Dial("tcp", podAddress)
	}, func(err error) {
		m.log().Warn("published port forwarding failed", "port", port, "error", err)
	})
	m.log().Info("pod port published", "port", port, "protocol", protocol.String(), "socket", socketName)
	return socketName, nil
}

// Unpublish stops forwarding and removes the socket. Unpublishing a port that
// is not published is a no-op, so cleanup paths can call it unconditionally.
func (m *Manager) Unpublish(protocol guest.Protocol, port uint32) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.unpublishLocked(key{protocol: protocol, port: port})
}

func (m *Manager) unpublishLocked(k key) {
	e, ok := m.entries[k]
	if !ok {
		return
	}
	delete(m.entries, k)
	_ = e.listener.Close()
	_ = os.Remove(filepath.Join(m.Dir, e.name))
	m.log().Info("pod port unpublished", "port", k.port)
}

// Close stops every published port and removes its socket.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k := range m.entries {
		m.unpublishLocked(k)
	}
}

// Sweep removes published sockets left behind by a previous agent process. It
// never touches the guest agent's own socket, which does not match the
// published naming scheme.
func (m *Manager) Sweep() error {
	dirEntries, err := os.ReadDir(m.Dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, dirEntry := range dirEntries {
		if dirEntry.IsDir() || !publishedName.MatchString(dirEntry.Name()) {
			continue
		}
		if err := os.Remove(filepath.Join(m.Dir, dirEntry.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
		m.log().Info("removed a stale published socket", "socket", dirEntry.Name())
	}
	return nil
}
