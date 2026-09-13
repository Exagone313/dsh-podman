// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestValidateProcessID(t *testing.T) {
	server := New()
	cases := map[string]bool{
		"1":    true,
		"42":   true,
		"":     false,
		"abc":  false,
		"12a":  false,
		"-1":   false,
		"1.5":  false,
		"1e3":  false,
		"0x1f": false,
		" 1":   false,
	}
	for id, expected := range cases {
		if got := server.ValidateProcessID(id); got != expected {
			t.Errorf("ValidateProcessID(%q) = %v, want %v", id, got, expected)
		}
	}
}

func TestSignalForName(t *testing.T) {
	cases := map[string]os.Signal{
		"":        syscall.SIGTERM,
		"SIGTERM": syscall.SIGTERM,
		"SIGKILL": syscall.SIGKILL,
		"SIGINT":  syscall.SIGINT,
		"SIGHUP":  syscall.SIGHUP,
		"SIGQUIT": syscall.SIGQUIT,
		"SIGUSR1": syscall.SIGUSR1,
		"SIGUSR2": syscall.SIGUSR2,
	}
	for name, want := range cases {
		got, err := signalForName(name)
		if err != nil || got != want {
			t.Errorf("signalForName(%q) = %v, %v; want %v", name, got, err, want)
		}
	}
	// SIGTERM must not resolve to os.Interrupt: that is SIGINT, and a process
	// ignoring SIGINT would never stop.
	if got, _ := signalForName("SIGTERM"); got == os.Interrupt {
		t.Error("SIGTERM resolved to SIGINT")
	}
	for _, name := range []string{"SIGBOGUS", "sigterm", "TERM", "9", " SIGTERM"} {
		if _, err := signalForName(name); err == nil {
			t.Errorf("accepted unknown signal %q", name)
		}
	}
}

func TestSignalRejectsUnknownName(t *testing.T) {
	server := New()
	process, err := server.Processes.Start(context.Background(), []string{"sleep", "60"}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Processes.Remove(process.ID)
	if err := process.Command.Start(); err != nil {
		t.Skipf("cannot start a helper process: %v", err)
	}
	defer func() { _ = process.Command.Process.Kill() }()
	if _, err := server.Signal(context.Background(), &guest.SignalRequest{ProcessId: process.ID, Signal: "SIGBOGUS"}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

// TestSignalUnknownProcess covers a Signal for an id that was never handed
// out.
func TestSignalUnknownProcess(t *testing.T) {
	server := New()
	if _, err := server.Signal(context.Background(), &guest.SignalRequest{ProcessId: "1", Signal: "SIGTERM"}); status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

// TestSignalUnstartedProcess covers a Signal that lands between a process
// being registered and being started. Exec registers first, so the process is
// reachable while Command.Process is still nil; dereferencing it panicked and
// took the whole agent down with it.
func TestSignalUnstartedProcess(t *testing.T) {
	server := New()
	process, err := server.Processes.Start(context.Background(), []string{"sleep", "60"}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Processes.Remove(process.ID)
	if process.Command.Process != nil {
		t.Fatal("process should not be started yet")
	}
	response, err := server.Signal(context.Background(), &guest.SignalRequest{ProcessId: process.ID, Signal: "SIGTERM"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v (%v)", err, response)
	}
}

// TestExecDropsProcessesItCannotStart covers the bookkeeping around a failed
// start: leaving the entry behind would keep a process with no os.Process in
// the map for the agent's lifetime.
func TestExecDropsProcessesItCannotStart(t *testing.T) {
	server := New()
	process, err := server.Processes.Start(context.Background(), []string{filepath.Join(t.TempDir(), "missing")}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Command.Start(); err == nil {
		t.Fatal("expected the command to fail to start")
	}
	server.Processes.Remove(process.ID)
	if len(server.Processes.List()) != 0 {
		t.Fatalf("process left registered: %#v", server.Processes.List())
	}
}

func TestExecSpillsFullOutput(t *testing.T) {
	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{{
		Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv:        []string{"sh", "-c", "printf hello"},
			Cwd:         root,
			SpillStdout: &guest.SpillTarget{Path: "/workspace/spill.log", MaxBytes: 1024},
		}},
	}}}
	if err := server.Exec(stream); err != nil {
		t.Fatal(err)
	}
	exit := stream.exit()
	if exit == nil || !exit.GetStdoutSpillValid() {
		t.Fatalf("expected a valid stdout spill, got %#v", exit)
	}
	if stream.stdout() != "hello" {
		t.Fatalf("stdout = %q, want hello", stream.stdout())
	}
	data, err := os.ReadFile(filepath.Join(root, "spill.log"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("spill = %q, want hello", string(data))
	}
}

func TestExecDiscardsSpillPastTheCap(t *testing.T) {
	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{{
		Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv:        []string{"sh", "-c", "printf 0123456789"},
			Cwd:         root,
			SpillStdout: &guest.SpillTarget{Path: "/workspace/spill.log", MaxBytes: 4},
		}},
	}}}
	if err := server.Exec(stream); err != nil {
		t.Fatal(err)
	}
	exit := stream.exit()
	if exit == nil || exit.GetStdoutSpillValid() {
		t.Fatalf("expected an invalid stdout spill, got %#v", exit)
	}
	if _, err := os.Stat(filepath.Join(root, "spill.log")); !os.IsNotExist(err) {
		t.Fatalf("spill file should have been removed: %v", err)
	}
}

func TestExecAppliesUnsetEnv(t *testing.T) {
	server, root := newTestServer(t)
	t.Setenv("DSH_TEST_UNSET", "present")
	stream := &execStream{inputs: []*guest.ExecInput{{
		Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv:     []string{"sh", "-c", "printf %s \"$DSH_TEST_UNSET\""},
			Cwd:      root,
			UnsetEnv: []string{"DSH_TEST_UNSET"},
		}},
	}}}
	if err := server.Exec(stream); err != nil {
		t.Fatal(err)
	}
	if got := stream.stdout(); got != "" {
		t.Fatalf("unset variable leaked: %q", got)
	}
}
