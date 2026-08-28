// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package exec

import (
	"context"
	"strings"
	"testing"
)

func TestStartRejectsEmptyArgv(t *testing.T) {
	manager := NewManager()
	for _, argv := range [][]string{nil, {}, {""}} {
		if _, err := manager.Start(context.Background(), argv, "", nil); err == nil {
			t.Fatalf("accepted argv %#v", argv)
		}
	}
}

func TestStartAssignsSequentialIDs(t *testing.T) {
	manager := NewManager()
	first, err := manager.Start(context.Background(), []string{"echo", "hi"}, "/tmp", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Start(context.Background(), []string{"pwd"}, "/", nil)
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
	manager := NewManager()
	process, err := manager.Start(context.Background(), []string{"sleep", "1"}, "", nil)
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
	manager := NewManager()
	process, err := manager.Start(context.Background(), []string{"env"}, "", map[string]string{"FOO": "bar"})
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

func TestStartLeavesEnvUnsetWhenAbsent(t *testing.T) {
	manager := NewManager()
	process, err := manager.Start(context.Background(), []string{"env"}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if process.Command.Env != nil {
		t.Fatalf("expected nil env, got %#v", process.Command.Env)
	}
}

func TestListCopiesProcesses(t *testing.T) {
	manager := NewManager()
	if _, err := manager.Start(context.Background(), []string{"true"}, "", nil); err != nil {
		t.Fatal(err)
	}
	got := manager.List()
	got[0] = nil
	if remaining := manager.List(); len(remaining) != 1 {
		t.Fatalf("list is not a copy: %#v", remaining)
	}
}

func TestStartCopiesArgv(t *testing.T) {
	manager := NewManager()
	argv := []string{"echo", "x"}
	process, err := manager.Start(context.Background(), argv, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	argv[0] = "mutated"
	if process.Argv[0] != "echo" {
		t.Fatalf("argv not copied: %#v", process.Argv)
	}
}

func TestStartUsesConfiguredWorkingDirectory(t *testing.T) {
	manager := NewManager()
	process, err := manager.Start(context.Background(), []string{"pwd"}, "/srv", nil)
	if err != nil {
		t.Fatal(err)
	}
	if process.Command.Dir != "/srv" {
		t.Fatalf("working directory not applied: %q", process.Command.Dir)
	}
}

func TestStartPropagatesCommandInArgv(t *testing.T) {
	manager := NewManager()
	process, err := manager.Start(context.Background(), []string{"bash", "-c", "echo hi"}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(process.Command.Args, " ") != "bash -c echo hi" {
		t.Fatalf("command args mismatch: %#v", process.Command.Args)
	}
}
