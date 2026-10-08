// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package publish

import (
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
)

func newManager(t *testing.T, dir string) *Manager {
	t.Helper()
	m := New(dir)
	m.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	t.Cleanup(m.Close)
	return m
}

// startPodPort listens on a loopback port the way a daemon in the pod would,
// echoing what it receives.
func startPodPort(t *testing.T) uint32 {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return uint32(listener.Addr().(*net.TCPAddr).Port)
}

func TestPublishForwardsToThePodPort(t *testing.T) {
	dir := t.TempDir()
	port := startPodPort(t)
	m := newManager(t, dir)
	name, err := m.Publish(guest.Protocol_PROTOCOL_TCP, port)
	if err != nil {
		t.Fatal(err)
	}
	if want := "t" + strconv.FormatUint(uint64(port), 10); name != want {
		t.Fatalf("socket name = %q, want %q", name, want)
	}
	conn, err := net.Dial("unix", filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len("hello"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "hello" {
		t.Fatalf("echoed %q, want hello", buf)
	}
}

func TestPublishIsIdempotent(t *testing.T) {
	m := newManager(t, t.TempDir())
	port := startPodPort(t)
	first, err := m.Publish(guest.Protocol_PROTOCOL_TCP, port)
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.Publish(guest.Protocol_PROTOCOL_TCP, port)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("republish changed the socket name: %q then %q", first, second)
	}
	if m.entries == nil || len(m.entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(m.entries))
	}
}

func TestPublishRejectsUnsupportedRequests(t *testing.T) {
	m := newManager(t, t.TempDir())
	cases := map[string]struct {
		protocol guest.Protocol
		port     uint32
	}{
		"udp":               {guest.Protocol_PROTOCOL_UDP, 8080},
		"unspecified":       {guest.Protocol_PROTOCOL_UNSPECIFIED, 8080},
		"http":              {guest.Protocol_PROTOCOL_HTTP, 8080},
		"zero port":         {guest.Protocol_PROTOCOL_TCP, 0},
		"port out of range": {guest.Protocol_PROTOCOL_TCP, 70000},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := m.Publish(tc.protocol, tc.port)
			var invalid InvalidError
			if !errors.As(err, &invalid) {
				t.Fatalf("expected an InvalidError, got %v", err)
			}
		})
	}
}

func TestUnpublishRemovesTheSocket(t *testing.T) {
	dir := t.TempDir()
	port := startPodPort(t)
	m := newManager(t, dir)
	name, err := m.Publish(guest.Protocol_PROTOCOL_TCP, port)
	if err != nil {
		t.Fatal(err)
	}
	m.Unpublish(guest.Protocol_PROTOCOL_TCP, port)
	if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
		t.Fatalf("socket file still there after Unpublish: %v", err)
	}
	// Unpublishing again is a no-op, so cleanup paths can call it blindly.
	m.Unpublish(guest.Protocol_PROTOCOL_TCP, port)
}

func TestSweepRemovesOnlyPublishedSockets(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"t8080", "u53", "guest.sock", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m := newManager(t, dir)
	if err := m.Sweep(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"t8080", "u53"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s was not swept: %v", name, err)
		}
	}
	for _, name := range []string{"guest.sock", "notes.txt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s should have been left alone: %v", name, err)
		}
	}
}

func TestPublishCapsTheNumberOfPorts(t *testing.T) {
	m := newManager(t, t.TempDir())
	for i := 0; i < maxPublished; i++ {
		if _, err := m.Publish(guest.Protocol_PROTOCOL_TCP, uint32(20000+i)); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
	}
	_, err := m.Publish(guest.Protocol_PROTOCOL_TCP, 30000)
	var invalid InvalidError
	if !errors.As(err, &invalid) {
		t.Fatalf("expected the cap to refuse the extra port, got %v", err)
	}
}
