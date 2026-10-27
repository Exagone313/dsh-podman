// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	workspacefs "github.com/Exagone313/dsh-podman/internal/guestagent/fs"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestWriteTemplateCreatesDirectory(t *testing.T) {
	server, root := newTestServer(t)
	response, err := server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
		ProjectDir: "/workspace",
		Name:       "web",
		Content:    []byte("version: 1\n"),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, ".dsh-podman", "web.yml")
	if response.GetPath() != want {
		t.Fatalf("path = %q, want %q", response.GetPath(), want)
	}
	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "version: 1\n" {
		t.Fatalf("content = %q", data)
	}
	info, err := os.Stat(filepath.Join(root, ".dsh-podman"))
	if err != nil || !info.IsDir() {
		t.Fatalf("template directory was not created: %v", err)
	}
}

func TestWriteTemplateReusesDirectoryAndOverwrites(t *testing.T) {
	server, root := newTestServer(t)
	directory := filepath.Join(root, ".dsh-podman")
	if err := os.Mkdir(directory, 0755); err != nil {
		t.Fatal(err)
	}
	first, err := server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
		ProjectDir: "/workspace",
		Name:       "web.yml",
		Content:    []byte("old"),
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
		ProjectDir: "/workspace",
		Name:       "web.yml",
		Content:    []byte("new"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.GetPath() != second.GetPath() {
		t.Fatalf("re-saving changed the path: %q != %q", first.GetPath(), second.GetPath())
	}
	data, err := os.ReadFile(second.GetPath())
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("content = %q, want %q", data, "new")
	}
}

func TestWriteTemplateNormalizesTheSuffix(t *testing.T) {
	server, _ := newTestServer(t)
	for _, test := range []struct{ name, want string }{
		{name: "web", want: "web.yml"},
		{name: "web.yml", want: "web.yml"},
		{name: "web.yaml", want: "web.yaml"},
	} {
		response, err := server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
			ProjectDir: "/workspace",
			Name:       test.name,
			Content:    []byte("version: 1\n"),
		})
		if err != nil {
			t.Fatalf("%q: %v", test.name, err)
		}
		if got := filepath.Base(response.GetPath()); got != test.want {
			t.Fatalf("%q wrote %q, want %q", test.name, got, test.want)
		}
	}
}

func TestWriteTemplateRefusesNonBasenames(t *testing.T) {
	server, _ := newTestServer(t)
	for _, name := range []string{
		"",
		"../escape",
		"a/b",
		`a\b`,
		".",
		"..",
		".hidden",
		"/absolute",
		"nul\x00byte",
		"line\nbreak",
		strings.Repeat("a", 201),
	} {
		_, err := server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
			ProjectDir: "/workspace",
			Name:       name,
			Content:    []byte("version: 1\n"),
		})
		if status.Code(err) != codes.InvalidArgument {
			t.Fatalf("%q: expected InvalidArgument, got %v", name, err)
		}
	}
}

func TestWriteTemplateRefusesEmptyContent(t *testing.T) {
	server, _ := newTestServer(t)
	_, err := server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
		ProjectDir: "/workspace",
		Name:       "web",
	})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestWriteTemplateReportsAReadOnlyMount(t *testing.T) {
	root := t.TempDir()
	filesystem, err := workspacefs.New([]workspacefs.Mount{{
		Virtual:  "/workspace",
		Host:     root,
		ReadOnly: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	server := New().WithFS(filesystem)
	_, err = server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
		ProjectDir: "/workspace",
		Name:       "web",
		Content:    []byte("version: 1\n"),
	})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected PermissionDenied, got %v", err)
	}
	if !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("error does not name the read-only mount: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, ".dsh-podman")); !os.IsNotExist(statErr) {
		t.Fatalf("a read-only save created the template directory: %v", statErr)
	}
}

func TestWriteTemplateNamesAMissingProjectDirectory(t *testing.T) {
	server, _ := newTestServer(t)
	_, err := server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
		ProjectDir: "/workspace/missing",
		Name:       "web",
		Content:    []byte("version: 1\n"),
	})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestWriteTemplateRefusesAProjectFile(t *testing.T) {
	server, root := newTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := server.WriteTemplate(context.Background(), &guest.WriteTemplateRequest{
		ProjectDir: "/workspace/file",
		Name:       "web",
		Content:    []byte("version: 1\n"),
	})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}
