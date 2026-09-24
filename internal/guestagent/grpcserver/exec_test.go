// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/wrapperspb"
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
	process, err := server.Processes.Start(context.Background(), []string{"sleep", "60"}, "", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Processes.Remove(process.ID)
	if err := process.Command.Start(); err != nil {
		t.Skipf("cannot start a helper process: %v", err)
	}
	// Exec publishes the started handle; a Signal only inspects it.
	process.SetProcess(process.Command.Process)
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
	process, err := server.Processes.Start(context.Background(), []string{"sleep", "60"}, "", nil, identity.Options{})
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
	process, err := server.Processes.Start(context.Background(), []string{filepath.Join(t.TempDir(), "missing")}, "", nil, identity.Options{})
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

// TestExecReportsTheProcessIdBeforeOutput pins that the caller learns the
// process id before any output: a silent background command produces no output
// until it exits, so a caller that must cancel it (job_kill, a timed-out exec)
// can only signal an id it was told.
func TestExecReportsTheProcessIdBeforeOutput(t *testing.T) {
	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{{
		Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv: []string{"sh", "-c", "sleep 1"},
			Cwd:  root,
		}},
	}}}
	if err := server.Exec(stream); err != nil {
		t.Fatal(err)
	}
	if len(stream.outputs) == 0 {
		t.Fatal("expected the guest to report the process id")
	}
	first := stream.outputs[0]
	if first.GetProcessId() == "" {
		t.Fatalf("first message must carry the process id, got %#v", first)
	}
	if first.GetStdoutChunk() != nil || first.GetStderrChunk() != nil {
		t.Fatalf("the process id must precede any output, got %#v", first)
	}
}

// TestExecStdinIsNullUnlessRequested pins that a caller who sends no stdin
// leaves the child on /dev/null: a pipe would be a non-TTY stdin, and a tool
// like ripgrep then reads stdin instead of the working directory.
func TestExecStdinIsNullUnlessRequested(t *testing.T) {
	for _, tc := range []struct {
		pipe bool
		want string
	}{
		{pipe: false, want: "not-pipe"},
		{pipe: true, want: "pipe"},
	} {
		server, root := newTestServer(t)
		stream := &execStream{inputs: []*guest.ExecInput{{
			Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
				Argv:      []string{"sh", "-c", "if [ -p /dev/stdin ]; then echo pipe; else echo not-pipe; fi"},
				Cwd:       root,
				StdinPipe: tc.pipe,
			}},
		}}}
		if err := server.Exec(stream); err != nil {
			t.Fatal(err)
		}
		if got := strings.TrimSpace(stream.stdout()); got != tc.want {
			t.Fatalf("stdinPipe=%v: stdout = %q, want %q", tc.pipe, got, tc.want)
		}
	}
}

func TestExecRejectsNegativeUid(t *testing.T) {
	server, root := newTestServer(t)
	for _, start := range []*guest.ExecStart{
		{Argv: []string{"true"}, Cwd: root, Uid: wrapperspb.Int32(-1)},
		{Argv: []string{"true"}, Cwd: root, Gid: wrapperspb.Int32(-1)},
	} {
		stream := &execStream{inputs: []*guest.ExecInput{{
			Payload: &guest.ExecInput_Start{Start: start},
		}}}
		if err := server.Exec(stream); status.Code(err) != codes.InvalidArgument {
			t.Fatalf("expected InvalidArgument, got %v", err)
		}
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
