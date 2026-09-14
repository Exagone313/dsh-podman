// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package daemon

import (
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
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

func TestCredentialFor(t *testing.T) {
	uid1000 := uint32(1000)
	gid2000 := uint32(2000)
	cases := []struct {
		name string
		opts StartOptions
		want *syscall.Credential
	}{
		{name: "neither", opts: StartOptions{}, want: nil},
		{name: "groups only", opts: StartOptions{Groups: []uint32{3000}}, want: &syscall.Credential{Groups: []uint32{3000}}},
		{name: "uid only", opts: StartOptions{Uid: &uid1000}, want: &syscall.Credential{Uid: 1000, Gid: 1000}},
		{name: "gid only", opts: StartOptions{Gid: &gid2000}, want: &syscall.Credential{Uid: 0, Gid: 2000}},
		{name: "both", opts: StartOptions{Uid: &uid1000, Gid: &gid2000}, want: &syscall.Credential{Uid: 1000, Gid: 2000}},
		{name: "uid with groups", opts: StartOptions{Uid: &uid1000, Groups: []uint32{3000}}, want: &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{3000}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := credentialFor(tc.opts)
			if tc.want == nil {
				if got != nil {
					t.Fatalf("credentialFor() = %+v, want nil", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("credentialFor() = nil, want %+v", tc.want)
			}
			if got.Uid != tc.want.Uid || got.Gid != tc.want.Gid {
				t.Fatalf("credentialFor() = %+v, want uid=%d gid=%d", got, tc.want.Uid, tc.want.Gid)
			}
			if len(got.Groups) != len(tc.want.Groups) {
				t.Fatalf("credentialFor() groups = %v, want %v", got.Groups, tc.want.Groups)
			}
			for i := range tc.want.Groups {
				if got.Groups[i] != tc.want.Groups[i] {
					t.Fatalf("credentialFor() groups = %v, want %v", got.Groups, tc.want.Groups)
				}
			}
		})
	}
}

func TestStartWithUidRunsAsUser(t *testing.T) {
	if !CanSwitchUser() {
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
	if !CanSwitchUser() {
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
