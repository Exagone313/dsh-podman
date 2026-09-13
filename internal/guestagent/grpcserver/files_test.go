// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

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
