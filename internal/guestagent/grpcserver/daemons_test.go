// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"strings"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/guestagent/daemon"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func TestStopDaemonRejectsUnknownSignal(t *testing.T) {
	server := New()
	if _, err := server.StopDaemon(context.Background(), &guest.StopDaemonRequest{Name: "any", Signal: "SIGBOGUS"}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
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
