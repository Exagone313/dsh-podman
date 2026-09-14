// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package terminal

import (
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
)

// collectUntil drains PTY output until marker appears, failing on timeout.
func collectUntil(t *testing.T, output <-chan []byte, marker string, timeout time.Duration) string {
	t.Helper()
	deadline := time.After(timeout)
	var builder strings.Builder
	for {
		select {
		case chunk, ok := <-output:
			if !ok {
				t.Fatalf("output closed before %q appeared; got %q", marker, builder.String())
			}
			builder.Write(chunk)
			if strings.Contains(builder.String(), marker) {
				return builder.String()
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q; got %q", marker, builder.String())
		}
	}
}

func TestStartRejectsEmptyArgv(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	for _, argv := range [][]string{nil, {}, {""}} {
		if _, err := manager.Start(argv, "", nil, 0, 0); err == nil {
			t.Fatalf("accepted argv %#v", argv)
		}
	}
}

func TestSessionEchoInspectAndTerminate(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	session, err := manager.Start([]string{"/bin/sh"}, "", nil, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Terminate(2 * time.Second) })

	if session.Pid() <= 0 {
		t.Fatalf("unexpected pid %d", session.Pid())
	}
	if len(manager.List()) != 1 {
		t.Fatalf("session not registered: %d", len(manager.List()))
	}
	if err := session.Write([]byte("echo hi\n")); err != nil {
		t.Fatal(err)
	}
	output := collectUntil(t, session.Output(), "hi", 5*time.Second)
	if !strings.Contains(output, "hi") {
		t.Fatalf("output missing echo: %q", output)
	}
	if err := session.Resize(30, 100); err != nil {
		t.Fatal(err)
	}
	pgid, _, found := session.Inspect()
	if !found || pgid <= 0 {
		t.Fatalf("Inspect = (%d, _, %v), want a foreground group", pgid, found)
	}
	if err := session.Terminate(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	outcome := <-session.Done()
	if !outcome.Signaled {
		t.Fatalf("expected a signalled outcome, got %#v", outcome)
	}
	if _, ok := session.Outcome(); !ok {
		t.Fatal("expected a recorded outcome after exit")
	}
	waitForEmpty(t, manager)
}

func TestSessionExitsOnCommandCompletion(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	session, err := manager.Start([]string{"/bin/sh", "-c", "exit 7"}, "", nil, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case outcome := <-session.Done():
		if outcome.Signaled || outcome.ExitCode != 7 {
			t.Fatalf("outcome = %#v, want exit code 7", outcome)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("session did not exit")
	}
	waitForEmpty(t, manager)
}

func TestSignalForegroundUnknownSignal(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	session, err := manager.Start([]string{"/bin/sh"}, "", nil, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Terminate(2 * time.Second) })
	if pgid, found := session.SignalForeground("SIGNOTREAL"); found || pgid != 0 {
		t.Fatalf("SignalForeground = (%d, %v), want (0, false)", pgid, found)
	}
	if pgid, found := session.SignalForeground("SIGINT"); !found || pgid <= 0 {
		t.Fatalf("SignalForeground(SIGINT) = (%d, %v), want the foreground group", pgid, found)
	}
}

func TestManagerStopAll(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	session, err := manager.Start([]string{"/bin/sh"}, "", nil, 24, 80)
	if err != nil {
		t.Fatal(err)
	}
	manager.StopAll(syscall.SIGTERM)
	select {
	case <-session.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("StopAll did not stop the session")
	}
	waitForEmpty(t, manager)
}

func waitForEmpty(t *testing.T, manager *Manager) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(manager.List()) == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("manager still tracks %d sessions", len(manager.List()))
}
