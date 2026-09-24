// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package daemon

import (
	"errors"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
)

func findInfo(m *Manager, name string) *Daemon {
	for _, d := range m.List() {
		if d.Name == name {
			info := d
			return &info
		}
	}
	return nil
}

func waitFor(t *testing.T, m *Manager, name string, running bool) Daemon {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if info := findInfo(m, name); info != nil && info.Running == running {
			return *info
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("daemon %q did not reach running=%v in time", name, running)
	return Daemon{}
}

func cleanupDaemon(t *testing.T, m *Manager, name string) {
	t.Helper()
	t.Cleanup(func() {
		_ = m.Stop(name, syscall.SIGKILL)
	})
}

func TestStartRejectsEmptyArgv(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	if _, err := m.Start("a", nil, "", nil, StartOptions{}); err == nil {
		t.Fatal("expected error for empty argv")
	}
	if _, err := m.Start("a", []string{""}, "", nil, StartOptions{}); err == nil {
		t.Fatal("expected error for empty argv[0]")
	}
}

func TestStartRequiresName(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	if _, err := m.Start("", []string{"true"}, "", nil, StartOptions{}); err == nil {
		t.Fatal("expected an error for an empty daemon name")
	}
}

// TestStartWithholdsReservedEnv covers a daemon reading the agent's own
// credential straight out of its environment. It matters most for a daemon
// that drops privileges: it cannot read the agent's environment through
// /proc, but it was being handed a copy of it.
func TestStartWithholdsReservedEnv(t *testing.T) {
	t.Setenv("DSH_PODMAN_GUEST_TOKEN", "super-secret")
	t.Setenv("DSH_PODMAN_PROJECTS_ROOT", "/projects")
	m := NewManager(childenv.NewPaths())
	name, err := m.Start("printenv", []string{"env"}, "", map[string]string{"FOO": "bar"}, StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cleanupDaemon(t, m, name)
	waitFor(t, m, name, false)
	stdout, _, err := m.Logs(name, 0)
	if err != nil {
		t.Fatal(err)
	}
	output := string(stdout)
	if strings.Contains(output, "super-secret") {
		t.Error("the agent's credential reached the daemon's environment")
	}
	if strings.Contains(output, "DSH_PODMAN") {
		t.Errorf("reserved variables reached the daemon: %q", output)
	}
	if !strings.Contains(output, "FOO=bar") {
		t.Errorf("caller-supplied variables missing: %q", output)
	}
}

// TestStartIsolatedEnv covers a daemon that must not see the container's
// environment (secrets included): it gets only the PATH/HOME baseline and its
// own env.
func TestStartIsolatedEnv(t *testing.T) {
	t.Setenv("HOME", "/root")
	t.Setenv("INHERITED", "leak")
	m := NewManager(childenv.NewPaths())
	name, err := m.Start("printenv", []string{"env"}, "", map[string]string{"FOO": "bar"}, StartOptions{IsolatedEnv: true})
	if err != nil {
		t.Fatal(err)
	}
	cleanupDaemon(t, m, name)
	waitFor(t, m, name, false)
	stdout, _, err := m.Logs(name, 0)
	if err != nil {
		t.Fatal(err)
	}
	output := string(stdout)
	if strings.Contains(output, "leak") || strings.Contains(output, "INHERITED") {
		t.Errorf("container environment reached an isolated daemon: %q", output)
	}
	for _, want := range []string{"PATH=", "HOME=/root", "FOO=bar"} {
		if !strings.Contains(output, want) {
			t.Errorf("isolated daemon missing %q: %q", want, output)
		}
	}
}

func TestStartRejectsInvalidNames(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	for _, name := range []string{"-foo", "foo bar", "a/b", "foo@bar", strings.Repeat("a", 65)} {
		if _, err := m.Start(name, []string{"true"}, "", nil, StartOptions{}); err == nil {
			t.Errorf("expected error for name %q", name)
		}
	}
}

func TestStartErrAlreadyRunning(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	name, err := m.Start("long", []string{"sleep", "30"}, "", nil, StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cleanupDaemon(t, m, name)
	if _, err := m.Start(name, []string{"true"}, "", nil, StartOptions{}); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("expected ErrAlreadyRunning, got %v", err)
	}
}

func TestStartStopNonRunningReturnsNil(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	name, err := m.Start("quick", []string{"true"}, "", nil, StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, m, name, false)
	if err := m.Stop(name, syscall.SIGTERM); err != nil {
		t.Fatalf("Stop on a stopped daemon returned %v", err)
	}
}

func TestShortLivedCommandExitsZero(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	name, err := m.Start("greet", []string{"sh", "-c", "echo hi; sleep 0.05"}, "", nil, StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	info := waitFor(t, m, name, false)
	if info.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", info.ExitCode)
	}
	if info.StoppedAt == "" {
		t.Fatal("stopped_at not set")
	}
	stdout, stderr, err := m.Logs(name, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stdout), "hi") {
		t.Fatalf("stdout %q does not contain hi", stdout)
	}
	if len(stderr) != 0 {
		t.Fatalf("stderr %q, want empty", stderr)
	}
}

func TestStopTerminates(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	name, err := m.Start("sleeper", []string{"sleep", "30"}, "", nil, StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cleanupDaemon(t, m, name)
	if err := m.Stop(name, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	waitFor(t, m, name, false)
}

func TestStopAll(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	for _, name := range []string{"b", "a"} {
		if _, err := m.Start(name, []string{"sleep", "30"}, "", nil, StartOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	cleanupDaemon(t, m, "a")
	cleanupDaemon(t, m, "b")
	stopped := m.StopAll(syscall.SIGTERM)
	if len(stopped) != 2 || stopped[0] != "a" || stopped[1] != "b" {
		t.Fatalf("StopAll returned %v, want [a b]", stopped)
	}
	for _, name := range stopped {
		waitFor(t, m, name, false)
	}
}

func TestStopAllNoDaemons(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	if stopped := m.StopAll(syscall.SIGTERM); len(stopped) != 0 {
		t.Fatalf("StopAll on empty manager returned %v", stopped)
	}
}

func TestRestartReruns(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	name, err := m.Start("worker", []string{"sh", "-c", "echo one; sleep 1"}, "", nil, StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cleanupDaemon(t, m, name)
	if err := m.Restart(name); err != nil {
		t.Fatal(err)
	}
	info := findInfo(m, name)
	if info == nil || !info.Running {
		t.Fatalf("daemon not running after restart: %#v", info)
	}
	if len(info.Argv) != 3 || !strings.Contains(strings.Join(info.Argv, " "), "echo one") {
		t.Fatalf("argv not preserved: %v", info.Argv)
	}
}

func TestLogsTail(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	name, err := m.Start("tailer", []string{"sh", "-c", "printf 'abcdefghij'"}, "", nil, StartOptions{})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, m, name, false)
	stdout, _, err := m.Logs(name, 4)
	if err != nil {
		t.Fatal(err)
	}
	if string(stdout) != "ghij" {
		t.Fatalf("tail = %q, want %q", stdout, "ghij")
	}
}

func TestUnknownDaemon(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	if err := m.Stop("nope", syscall.SIGTERM); !errors.Is(err, ErrUnknown) {
		t.Fatalf("Stop: %v", err)
	}
	if err := m.Restart("nope"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("Restart: %v", err)
	}
	if _, _, err := m.Logs("nope", 0); !errors.Is(err, ErrUnknown) {
		t.Fatalf("Logs: %v", err)
	}
}

func TestListSortedByNames(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	for _, name := range []string{"zebra", "alpha", "mike"} {
		if _, err := m.Start(name, []string{"true"}, "", nil, StartOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	got := m.List()
	for i := 1; i < len(got); i++ {
		if got[i].Name < got[i-1].Name {
			t.Fatalf("list not sorted: %v", got)
		}
	}
}

// TestListReportsGroups pins that List surfaces a daemon's supplementary groups
// and copies them, so a caller cannot mutate the manager's own state. The
// daemon is registered directly because starting one with groups needs
// CAP_SETGID, which CI lacks.
func TestListReportsGroups(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	m.daemons["web"] = &daemon{info: Daemon{Name: "web", Running: true, Groups: []uint32{3000, 4000}}}
	got := m.List()
	if len(got) != 1 || !slices.Equal(got[0].Groups, []uint32{3000, 4000}) {
		t.Fatalf("groups not reported: %#v", got)
	}
	// The snapshot must not alias the stored slice.
	got[0].Groups[0] = 9999
	if again := m.List(); again[0].Groups[0] != 3000 {
		t.Fatalf("list aliases the stored groups: %#v", again)
	}
}

func TestStartWithUidRunsAsUser(t *testing.T) {
	if !identity.CanSwitchUser() {
		t.Skip("requires uid switching")
	}
	m := NewManager(childenv.NewPaths())
	uid := uint32(1000)
	name, err := m.Start("uidtest", []string{"id", "-u"}, "", nil, StartOptions{Uid: &uid})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, m, name, false)
	info := findInfo(m, name)
	if info == nil {
		t.Fatal("daemon not found")
	}
	if info.Uid != 1000 || info.Gid != 1000 {
		t.Fatalf("uid=%d gid=%d, want 1000 1000", info.Uid, info.Gid)
	}
	stdout, _, err := m.Logs(name, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(stdout)); got != "1000" {
		t.Fatalf("stdout = %q, want 1000", got)
	}
}

func TestStartUidOnlyDefaultsGid(t *testing.T) {
	if !identity.CanSwitchUser() {
		t.Skip("requires uid switching")
	}
	m := NewManager(childenv.NewPaths())
	uid := uint32(1000)
	name, err := m.Start("uidgidtest", []string{"sh", "-c", "id -g"}, "", nil, StartOptions{Uid: &uid})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, m, name, false)
	stdout, _, err := m.Logs(name, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(stdout)); got != "1000" {
		t.Fatalf("stdout = %q, want 1000", got)
	}
}

func TestStartRejectsInvalidNameTyped(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	if _, err := m.Start("-bad", []string{"true"}, "", nil, StartOptions{}); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("err = %v, want ErrInvalidName", err)
	}
}

// TestStartCapsTrackedDaemons pins the memory bound: stopped daemons are
// forgotten to make room, and a full set of running ones is refused instead of
// growing the capture rings without limit.
func TestStartCapsTrackedDaemons(t *testing.T) {
	m := NewManager(childenv.NewPaths())
	base := time.Now().UTC().Format(time.RFC3339)
	m.mu.Lock()
	for i := 0; i < maxDaemons; i++ {
		name := "stopped" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		m.daemons[name] = &daemon{info: Daemon{Name: name, Running: false, StoppedAt: base}}
	}
	m.mu.Unlock()

	// A new start makes room by evicting stopped daemons.
	name, err := m.Start("fresh", []string{"sleep", "60"}, "", nil, StartOptions{})
	if err != nil {
		t.Fatalf("expected a start to evict stale entries: %v", err)
	}
	_ = m.Stop(name, syscall.SIGKILL)

	// A full set of running daemons is refused.
	m.mu.Lock()
	m.daemons = map[string]*daemon{}
	for i := 0; i < maxDaemons; i++ {
		n := "running" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		m.daemons[n] = &daemon{info: Daemon{Name: n, Running: true}}
	}
	m.mu.Unlock()
	if _, err := m.Start("extra", []string{"sleep", "60"}, "", nil, StartOptions{}); !errors.Is(err, ErrTooMany) {
		t.Fatalf("err = %v, want ErrTooMany", err)
	}
}
