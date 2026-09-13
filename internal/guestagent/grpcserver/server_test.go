// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/guestagent/daemon"
	workspacefs "github.com/Exagone313/dsh-podman/internal/guestagent/fs"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	filesystem, err := workspacefs.New([]workspacefs.Mount{{Virtual: "/workspace", Host: root}})
	if err != nil {
		t.Fatal(err)
	}
	return New().WithFS(filesystem), root
}

// readFileStream collects the chunks a ReadFile handler sends.
type readFileStream struct {
	grpc.ServerStream
	chunks [][]byte
}

func (s *readFileStream) Send(chunk *guest.ReadFileChunk) error {
	s.chunks = append(s.chunks, append([]byte(nil), chunk.GetData()...))
	return nil
}

func (s *readFileStream) data() string {
	return string(bytes.Join(s.chunks, nil))
}

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

func TestStopDaemonRejectsUnknownSignal(t *testing.T) {
	server := New()
	if _, err := server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "any", Signal: "SIGBOGUS"}); status.Code(err) != codes.InvalidArgument {
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

// execStream is a fake Exec server stream: it replays queued inputs and records
// every output the handler sends.
type execStream struct {
	grpc.ServerStream
	inputs  []*guest.ExecInput
	outputs []*guest.ExecOutput
	index   int
}

func (s *execStream) Send(output *guest.ExecOutput) error {
	s.outputs = append(s.outputs, output)
	return nil
}

func (s *execStream) Context() context.Context {
	return context.Background()
}

func (s *execStream) Recv() (*guest.ExecInput, error) {
	if s.index >= len(s.inputs) {
		return nil, io.EOF
	}
	input := s.inputs[s.index]
	s.index++
	return input, nil
}

func (s *execStream) exit() *guest.ExecExit {
	for _, output := range s.outputs {
		if exit := output.GetExit(); exit != nil {
			return exit
		}
	}
	return nil
}

func (s *execStream) stdout() string {
	var builder strings.Builder
	for _, output := range s.outputs {
		builder.Write(output.GetStdoutChunk())
	}
	return builder.String()
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

func TestStatExistingFile(t *testing.T) {
	server, root := newTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	response, err := server.Stat(context.Background(), &guest.StatRequest{Path: "/workspace/file"})
	if err != nil {
		t.Fatal(err)
	}
	if !response.Exists || response.IsDir || response.Size != 5 {
		t.Fatalf("unexpected stat response: %#v", response)
	}
}

func TestStatMissingFile(t *testing.T) {
	server, _ := newTestServer(t)
	response, err := server.Stat(context.Background(), &guest.StatRequest{Path: "/workspace/absent"})
	if err != nil {
		t.Fatal(err)
	}
	if response.Exists {
		t.Fatalf("missing file reported as existing: %#v", response)
	}
}

func TestStatDirectory(t *testing.T) {
	server, root := newTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "dir"), 0755); err != nil {
		t.Fatal(err)
	}
	response, err := server.Stat(context.Background(), &guest.StatRequest{Path: "/workspace/dir"})
	if err != nil {
		t.Fatal(err)
	}
	if !response.Exists || !response.IsDir {
		t.Fatalf("unexpected stat response: %#v", response)
	}
}

func TestStatRejectsEscape(t *testing.T) {
	server, _ := newTestServer(t)
	_, err := server.Stat(context.Background(), &guest.StatRequest{Path: "/etc/passwd"})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected PermissionDenied, got %v", err)
	}
}

func TestStatNoFollowSymlink(t *testing.T) {
	server, root := newTestServer(t)
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	followed, err := server.Stat(context.Background(), &guest.StatRequest{Path: "/workspace/link"})
	if err != nil {
		t.Fatal(err)
	}
	if !followed.Exists || followed.IsSymlink {
		t.Fatalf("expected followed symlink, got %#v", followed)
	}
	entry, err := server.Stat(context.Background(), &guest.StatRequest{Path: "/workspace/link", NoFollow: true})
	if err != nil {
		t.Fatal(err)
	}
	if !entry.Exists || !entry.IsSymlink {
		t.Fatalf("expected symlink entry, got %#v", entry)
	}
}

func TestReadFileOffsetAndLength(t *testing.T) {
	server, root := newTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	window := &readFileStream{}
	if err := server.ReadFile(&guest.ReadFileRequest{Path: "/workspace/file", Offset: 3, Length: 4}, window); err != nil {
		t.Fatal(err)
	}
	if got := window.data(); got != "3456" {
		t.Fatalf("ReadFile window = %q, want %q", got, "3456")
	}
	toEOF := &readFileStream{}
	if err := server.ReadFile(&guest.ReadFileRequest{Path: "/workspace/file", Offset: 3}, toEOF); err != nil {
		t.Fatal(err)
	}
	if got := toEOF.data(); got != "3456789" {
		t.Fatalf("ReadFile to EOF = %q, want %q", got, "3456789")
	}
}

func TestReadDirListsEntries(t *testing.T) {
	server, root := newTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	response, err := server.ReadDir(context.Background(), &guest.ReadDirRequest{Path: "/workspace"})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Entries) != 2 {
		t.Fatalf("unexpected entries: %#v", response.Entries)
	}
	byName := map[string]*guest.DirEntry{}
	for _, entry := range response.Entries {
		byName[entry.Name] = entry
	}
	if byName["a.txt"].IsDir || byName["a.txt"].Size != 0 {
		t.Fatalf("unexpected file entry: name=%s isDir=%v size=%d", byName["a.txt"].Name, byName["a.txt"].IsDir, byName["a.txt"].Size)
	}
	if byName["a.txt"].Type != "file" {
		t.Fatalf("a.txt type = %q, want file", byName["a.txt"].Type)
	}
	if !byName["sub"].IsDir {
		t.Fatalf("unexpected dir entry: name=%s isDir=%v", byName["sub"].Name, byName["sub"].IsDir)
	}
	if byName["sub"].Type != "directory" {
		t.Fatalf("sub type = %q, want directory", byName["sub"].Type)
	}
}

func TestReadDirFollowsSymlinks(t *testing.T) {
	server, root := newTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "target"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target", filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("missing", filepath.Join(root, "broken")); err != nil {
		t.Fatal(err)
	}
	response, err := server.ReadDir(context.Background(), &guest.ReadDirRequest{Path: "/workspace"})
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*guest.DirEntry{}
	for _, entry := range response.Entries {
		byName[entry.Name] = entry
	}
	if byName["link"].Type != "directory" || !byName["link"].IsDir {
		t.Fatalf("symlink to directory: type=%q isDir=%v", byName["link"].Type, byName["link"].IsDir)
	}
	if byName["broken"].Type != "other" {
		t.Fatalf("broken symlink type = %q, want other", byName["broken"].Type)
	}
}

func TestMkdirCreatesPath(t *testing.T) {
	server, root := newTestServer(t)
	if _, err := server.Mkdir(context.Background(), &guest.MkdirRequest{Path: "/workspace/newdir", Parents: false}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "newdir"))
	if err != nil || !info.IsDir() {
		t.Fatalf("directory not created: %v", err)
	}
}

func TestMkdirCreatesParents(t *testing.T) {
	server, root := newTestServer(t)
	if _, err := server.Mkdir(context.Background(), &guest.MkdirRequest{Path: "/workspace/a/b/c", Parents: true}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(root, "a", "b", "c")); err != nil || !info.IsDir() {
		t.Fatalf("nested directory not created: %v", err)
	}
}

func TestMkdirWithoutParentsFails(t *testing.T) {
	server, _ := newTestServer(t)
	if _, err := server.Mkdir(context.Background(), &guest.MkdirRequest{Path: "/workspace/a/b", Parents: false}); status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
}

func TestDeleteRemovesFile(t *testing.T) {
	server, root := newTestServer(t)
	target := filepath.Join(root, "file")
	if err := os.WriteFile(target, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Delete(context.Background(), &guest.DeleteRequest{Path: "/workspace/file"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("file not removed: %v", err)
	}
}

func TestDeleteRecursiveRemovesDirectory(t *testing.T) {
	server, root := newTestServer(t)
	if err := os.MkdirAll(filepath.Join(root, "tree", "leaf"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Delete(context.Background(), &guest.DeleteRequest{Path: "/workspace/tree", Recursive: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "tree")); !os.IsNotExist(err) {
		t.Fatalf("directory not removed: %v", err)
	}
}

func TestDeleteNonRecursiveOnDirectoryFails(t *testing.T) {
	server, root := newTestServer(t)
	if err := os.Mkdir(filepath.Join(root, "dir"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "file"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Delete(context.Background(), &guest.DeleteRequest{Path: "/workspace/dir"}); status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
}

func TestDeleteRejectsMountRoot(t *testing.T) {
	server, _ := newTestServer(t)
	_, err := server.Delete(context.Background(), &guest.DeleteRequest{Path: "/workspace", Recursive: true})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected PermissionDenied, got %v", err)
	}
}

func TestMkdirRejectsMountRoot(t *testing.T) {
	server, _ := newTestServer(t)
	_, err := server.Mkdir(context.Background(), &guest.MkdirRequest{Path: "/workspace"})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected PermissionDenied, got %v", err)
	}
}

func TestResolveWithoutFilesystem(t *testing.T) {
	server := New()
	if _, err := server.resolve("/workspace/x", false); err == nil {
		t.Fatal("resolve succeeded without filesystem")
	}
}

func waitDaemonState(t *testing.T, server *Server, name string, running bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := server.ListDaemons(context.Background(), &guest.ListDaemonsRequest{})
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range response.Daemons {
			if d.Name == name && d.Running == running {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("daemon %q did not reach running=%v in time", name, running)
}

func TestStartDaemonRejectsEmptyArgv(t *testing.T) {
	server := New()
	_, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Name: "web"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestStartDaemonAndList(t *testing.T) {
	server := New()
	info, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Name: "web", Argv: []string{"sh", "-c", "sleep 30"}})
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "web" || !info.Running {
		t.Fatalf("unexpected daemon info: %#v", info)
	}
	response, err := server.ListDaemons(context.Background(), &guest.ListDaemonsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range response.Daemons {
		if d.Name == "web" {
			found = true
		}
	}
	if !found {
		t.Fatal("daemon not listed")
	}
	if _, err := server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "web", Signal: "SIGKILL"}); err != nil {
		t.Fatal(err)
	}
}

func TestStartDaemonRejectsEmptyName(t *testing.T) {
	server := New()
	_, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Argv: []string{"true"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestStartDaemonReplaces(t *testing.T) {
	server := New()
	if _, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Name: "web", Argv: []string{"sleep", "30"}}); err != nil {
		t.Fatal(err)
	}
	info, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Name: "web", Argv: []string{"sleep", "60"}})
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "web" || !info.Running || len(info.Argv) != 2 || info.Argv[1] != "60" {
		t.Fatalf("unexpected replaced daemon: %#v", info)
	}
	response, err := server.ListDaemons(context.Background(), &guest.ListDaemonsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, d := range response.Daemons {
		if d.Name == "web" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one web daemon, got %d", count)
	}
	if _, err := server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "web", Signal: "SIGKILL"}); err != nil {
		t.Fatal(err)
	}
}

func TestDaemonLogs(t *testing.T) {
	server := New()
	if _, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Name: "web", Argv: []string{"sh", "-c", "echo hi"}}); err != nil {
		t.Fatal(err)
	}
	waitDaemonState(t, server, "web", false)
	response, err := server.DaemonLogs(context.Background(), &guest.DaemonLogsRequest{Name: "web"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(response.Stdout), "hi") {
		t.Fatalf("logs do not contain hi: %q", response.Stdout)
	}
}

func TestStartDaemonIsolatedEnv(t *testing.T) {
	t.Setenv("INHERITED", "leak")
	server := New()
	if _, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{
		Name:       "iso",
		Argv:       []string{"env"},
		Env:        map[string]string{"FOO": "bar"},
		InheritEnv: wrapperspb.Bool(false),
	}); err != nil {
		t.Fatal(err)
	}
	waitDaemonState(t, server, "iso", false)
	response, err := server.DaemonLogs(context.Background(), &guest.DaemonLogsRequest{Name: "iso"})
	if err != nil {
		t.Fatal(err)
	}
	output := string(response.Stdout)
	if strings.Contains(output, "INHERITED") {
		t.Errorf("container environment reached an isolated daemon: %q", output)
	}
	if !strings.Contains(output, "FOO=bar") {
		t.Errorf("caller-supplied variable missing: %q", output)
	}
}

func TestStopDaemonStops(t *testing.T) {
	server := New()
	if _, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Name: "web", Argv: []string{"sh", "-c", "sleep 30"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "web"}); err != nil {
		t.Fatal(err)
	}
	waitDaemonState(t, server, "web", false)
}

func TestStopDaemonUnknown(t *testing.T) {
	server := New()
	_, err := server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestStopAllDaemonsStops(t *testing.T) {
	server := New()
	for _, name := range []string{"a", "b"} {
		if _, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Name: name, Argv: []string{"sh", "-c", "sleep 30"}}); err != nil {
			t.Fatal(err)
		}
	}
	response, err := server.StopAllDaemons(context.Background(), &guest.StopAllDaemonsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Daemons) != 2 {
		t.Fatalf("StopAllDaemons returned %v, want 2 names", response.Daemons)
	}
	byName := map[string]bool{}
	for _, name := range response.Daemons {
		byName[name] = true
	}
	for _, name := range []string{"a", "b"} {
		if !byName[name] {
			t.Fatalf("StopAllDaemons returned %v, missing %q", response.Daemons, name)
		}
		waitDaemonState(t, server, name, false)
	}
}

func TestStopAllDaemonsEmpty(t *testing.T) {
	server := New()
	response, err := server.StopAllDaemons(context.Background(), &guest.StopAllDaemonsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Daemons) != 0 {
		t.Fatalf("StopAllDaemons returned %v, want empty", response.Daemons)
	}
}

func TestRestartDaemonReruns(t *testing.T) {
	server := New()
	if _, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{Name: "web", Argv: []string{"sh", "-c", "sleep 30"}}); err != nil {
		t.Fatal(err)
	}
	info, err := server.RestartDaemon(context.Background(), &guest.RestartDaemonRequest{Name: "web"})
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "web" || !info.Running {
		t.Fatalf("unexpected daemon info after restart: %#v", info)
	}
	if _, err := server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "web", Signal: "SIGKILL"}); err != nil {
		t.Fatal(err)
	}
}

func TestRestartDaemonUnknown(t *testing.T) {
	server := New()
	_, err := server.RestartDaemon(context.Background(), &guest.RestartDaemonRequest{Name: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestStartDaemonRejectsNegativeUid(t *testing.T) {
	server := New()
	_, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{
		Name: "web",
		Argv: []string{"sh", "-c", "sleep 30"},
		Uid:  wrapperspb.Int32(-1),
	})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestStartDaemonRejectsNegativeGid(t *testing.T) {
	server := New()
	_, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{
		Name: "web",
		Argv: []string{"sh", "-c", "sleep 30"},
		Gid:  wrapperspb.Int32(-1),
	})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestStartDaemonUidOnlyDefaultsGid(t *testing.T) {
	if !daemon.CanSwitchUser() {
		t.Skip("requires uid switching")
	}
	server := New()
	info, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{
		Name: "web",
		Argv: []string{"sh", "-c", "sleep 30"},
		Uid:  wrapperspb.Int32(1000),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "web", Signal: "SIGKILL"})
	})
	if info.Uid != 1000 || info.Gid != 1000 {
		t.Fatalf("uid=%d gid=%d, want 1000 1000", info.Uid, info.Gid)
	}
}

func TestStartDaemonNoUidGidDefaultsZero(t *testing.T) {
	server := New()
	info, err := server.StartDaemon(context.Background(), &guest.StartDaemonRequest{
		Name: "web",
		Argv: []string{"sh", "-c", "sleep 30"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "web", Signal: "SIGKILL"})
	})
	if info.Uid != 0 || info.Gid != 0 {
		t.Fatalf("uid=%d gid=%d, want 0 0", info.Uid, info.Gid)
	}
}

// writeFileStream feeds a WriteFile handler a fixed chunk list and captures the
// final response.
type writeFileStream struct {
	grpc.ServerStream
	chunks []*guest.WriteFileChunk
	index  int
	result *guest.WriteFileResponse
}

func (s *writeFileStream) Recv() (*guest.WriteFileChunk, error) {
	if s.index >= len(s.chunks) {
		return nil, io.EOF
	}
	chunk := s.chunks[s.index]
	s.index++
	return chunk, nil
}

func (s *writeFileStream) SendAndClose(response *guest.WriteFileResponse) error {
	s.result = response
	return nil
}

func TestWriteFilePreservesMode(t *testing.T) {
	server, root := newTestServer(t)
	target := filepath.Join(root, "script")
	if err := os.WriteFile(target, []byte("old"), 0755); err != nil {
		t.Fatal(err)
	}
	stream := &writeFileStream{chunks: []*guest.WriteFileChunk{
		{Payload: &guest.WriteFileChunk_Start{Start: &guest.WriteFileStart{Path: "/workspace/script", Create: true, Truncate: true}}},
		{Payload: &guest.WriteFileChunk_DataChunk{DataChunk: []byte("new")}},
	}}
	if err := server.WriteFile(stream); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0755 {
		t.Fatalf("mode = %v, want 0755", info.Mode().Perm())
	}
	if data, err := os.ReadFile(target); err != nil {
		t.Fatal(err)
	} else if string(data) != "new" {
		t.Fatalf("content = %q, want %q", data, "new")
	}
}
