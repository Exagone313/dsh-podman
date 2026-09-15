// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package exec

import (
	"context"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
)

func TestStartRejectsEmptyArgv(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	for _, argv := range [][]string{nil, {}, {""}} {
		if _, err := manager.Start(context.Background(), argv, "", nil, identity.Options{}); err == nil {
			t.Fatalf("accepted argv %#v", argv)
		}
	}
}

func TestStartAssignsSequentialIDs(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	first, err := manager.Start(context.Background(), []string{"echo", "hi"}, "/tmp", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Start(context.Background(), []string{"pwd"}, "/", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != "1" || second.ID != "2" {
		t.Fatalf("unexpected ids: %q, %q", first.ID, second.ID)
	}
	if len(first.Argv) != 2 || first.Argv[0] != "echo" {
		t.Fatalf("argv not preserved: %#v", first.Argv)
	}
}

func TestListAndRemove(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	process, err := manager.Start(context.Background(), []string{"sleep", "1"}, "", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := manager.List(); len(got) != 1 || got[0] != process {
		t.Fatalf("unexpected process list: %#v", got)
	}
	manager.Remove(process.ID)
	if got := manager.List(); len(got) != 0 {
		t.Fatalf("process not removed: %#v", got)
	}
	manager.Remove("missing")
}

func TestStartSetsEnv(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	process, err := manager.Start(context.Background(), []string{"env"}, "", map[string]string{"FOO": "bar"}, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if process.Command.Env == nil {
		t.Fatal("command env is nil")
	}
	found := false
	for _, entry := range process.Command.Env {
		if entry == "FOO=bar" {
			found = true
		}
	}
	if !found {
		t.Fatalf("env not applied: %#v", process.Command.Env)
	}
}

// TestStartAlwaysSetsEnv covers the case with no caller-supplied variables: a
// nil Command.Env would make the child inherit the agent's own environment,
// reserved variables and all.
func TestStartAlwaysSetsEnv(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	manager := NewManager(childenv.NewPaths())
	process, err := manager.Start(context.Background(), []string{"env"}, "", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if process.Command.Env == nil {
		t.Fatal("command env is nil; the child would inherit the agent's environment")
	}
	if !slices.Contains(process.Command.Env, "PATH=/usr/bin") {
		t.Errorf("ordinary variables should be inherited: %#v", process.Command.Env)
	}
}

// TestStartWithholdsReservedEnv covers the agent's own credential: it must not
// be handed to a process the agent starts, whether or not the caller supplies
// an environment.
func TestStartWithholdsReservedEnv(t *testing.T) {
	t.Setenv("DSH_PODMAN_GUEST_TOKEN", "super-secret")
	t.Setenv("DSH_PODMAN_PROJECTS_ROOT", "/projects")
	manager := NewManager(childenv.NewPaths())
	for _, env := range []map[string]string{nil, {"FOO": "bar"}} {
		process, err := manager.Start(context.Background(), []string{"env"}, "", env, identity.Options{})
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range process.Command.Env {
			if strings.HasPrefix(entry, "DSH_PODMAN") {
				t.Errorf("reserved variable passed to child: %q", entry)
			}
		}
	}
}

func TestListCopiesProcesses(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	if _, err := manager.Start(context.Background(), []string{"true"}, "", nil, identity.Options{}); err != nil {
		t.Fatal(err)
	}
	got := manager.List()
	got[0] = nil
	if remaining := manager.List(); len(remaining) != 1 {
		t.Fatalf("list is not a copy: %#v", remaining)
	}
}

func TestStartCopiesArgv(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	argv := []string{"echo", "x"}
	process, err := manager.Start(context.Background(), argv, "", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	argv[0] = "mutated"
	if process.Argv[0] != "echo" {
		t.Fatalf("argv not copied: %#v", process.Argv)
	}
}

func TestStartUsesConfiguredWorkingDirectory(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	process, err := manager.Start(context.Background(), []string{"pwd"}, "/srv", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if process.Command.Dir != "/srv" {
		t.Fatalf("working directory not applied: %q", process.Command.Dir)
	}
}

// TestStartAppliesIdentity pins that a requested identity becomes the child's
// process credential, and that no override leaves the command without one.
func TestStartAppliesIdentity(t *testing.T) {
	uid := uint32(1000)
	gid := uint32(2000)
	cases := []struct {
		name string
		opts identity.Options
		want *syscall.Credential
	}{
		{name: "none", opts: identity.Options{}, want: nil},
		{name: "uid only", opts: identity.Options{Uid: &uid}, want: &syscall.Credential{Uid: 1000, Gid: 1000}},
		{name: "both", opts: identity.Options{Uid: &uid, Gid: &gid}, want: &syscall.Credential{Uid: 1000, Gid: 2000}},
		{name: "groups", opts: identity.Options{Groups: []uint32{3000, 4000}}, want: &syscall.Credential{Groups: []uint32{3000, 4000}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			manager := NewManager(childenv.NewPaths())
			process, err := manager.Start(context.Background(), []string{"true"}, "", nil, tc.opts)
			if err != nil {
				t.Fatal(err)
			}
			if tc.want == nil {
				if process.Command.SysProcAttr != nil && process.Command.SysProcAttr.Credential != nil {
					t.Fatalf("unexpected credential: %#v", process.Command.SysProcAttr.Credential)
				}
				return
			}
			cred := process.Command.SysProcAttr.Credential
			if cred == nil || cred.Uid != tc.want.Uid || cred.Gid != tc.want.Gid || !slices.Equal(cred.Groups, tc.want.Groups) {
				t.Fatalf("credential = %#v, want %#v", cred, tc.want)
			}
		})
	}
}

// TestProcessGroupReachesChildren pins that a command leads its own process
// group: a shell defers a signal while its foreground child runs, so signalling
// the group (not just the shell) is what stops the command.
func TestProcessGroupReachesChildren(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	process, err := manager.Start(context.Background(), []string{"sh", "-c", "sleep 60"}, "", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if process.Command.SysProcAttr == nil || !process.Command.SysProcAttr.Setpgid {
		t.Fatalf("command must lead its own process group: %#v", process.Command.SysProcAttr)
	}
	if err := process.Command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- process.Command.Wait() }()
	if err := syscall.Kill(-process.Command.Process.Pid, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		_ = syscall.Kill(-process.Command.Process.Pid, syscall.SIGKILL)
		t.Fatal("the command did not exit after SIGTERM to its process group")
	}
}

func TestStartPropagatesCommandInArgv(t *testing.T) {
	manager := NewManager(childenv.NewPaths())
	process, err := manager.Start(context.Background(), []string{"bash", "-c", "echo hi"}, "", nil, identity.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(process.Command.Args, " ") != "bash -c echo hi" {
		t.Fatalf("command args mismatch: %#v", process.Command.Args)
	}
}
