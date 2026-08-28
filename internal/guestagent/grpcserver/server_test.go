// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	workspacefs "gitlab.com/Exagone313/dsh-podman/internal/guestagent/fs"
	guest "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
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

func TestValidateProcessID(t *testing.T) {
	server := New()
	cases := map[string]bool{
		"1":     true,
		"42":    true,
		"":      false,
		"abc":   false,
		"12a":   false,
		"-1":    false,
		"1.5":   false,
		"1e3":   false,
		"0x1f":  false,
		" 1":    false,
	}
	for id, expected := range cases {
		if got := server.ValidateProcessID(id); got != expected {
			t.Errorf("ValidateProcessID(%q) = %v, want %v", id, got, expected)
		}
	}
}

func TestSignalForName(t *testing.T) {
	if got := signalForName("SIGKILL"); got != os.Kill {
		t.Fatalf("signalForName(SIGKILL) = %v", got)
	}
	if got := signalForName("SIGTERM"); got != os.Interrupt {
		t.Fatalf("signalForName(SIGTERM) = %v", got)
	}
	if got := signalForName("SIGUSR1"); got != os.Interrupt {
		t.Fatalf("signalForName(SIGUSR1) = %v", got)
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
	if !byName["sub"].IsDir {
		t.Fatalf("unexpected dir entry: name=%s isDir=%v", byName["sub"].Name, byName["sub"].IsDir)
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
