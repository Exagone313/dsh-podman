// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestListCachesReportsConfiguredCaches(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "busybox-1.37.0-1-x86_64.pkg.tar.zst"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	server := &Server{ImageBuilder: &imagebuild.Builder{HostPacmanCache: dir}, Logger: silentLogger()}
	response, err := server.ListCaches(context.Background(), &ctl.ListCachesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Caches) != 1 || response.Caches[0].Manager != "pacman" || response.Caches[0].Path != dir || response.Caches[0].Files != 1 || response.Caches[0].Bytes <= 0 {
		t.Fatalf("unexpected caches: %#v", response.Caches)
	}
}

func TestListCachesWithoutImageBuilder(t *testing.T) {
	_, err := (&Server{Logger: silentLogger()}).ListCaches(context.Background(), &ctl.ListCachesRequest{})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestCleanCachesKeepsTheNewestPackage(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "busybox-1.36.1-1-x86_64.pkg.tar.zst")
	newest := filepath.Join(dir, "busybox-1.37.0-1-x86_64.pkg.tar.zst")
	for _, path := range []string{old, newest} {
		if err := os.WriteFile(path, []byte(filepath.Base(path)), 0644); err != nil {
			t.Fatal(err)
		}
	}
	oldTime := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(old, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	server := &Server{ImageBuilder: &imagebuild.Builder{HostPacmanCache: dir}, Logger: silentLogger()}
	response, err := server.CleanCaches(context.Background(), &ctl.CleanCachesRequest{Mode: ctl.CacheCleanMode_CACHE_CLEAN_MODE_KEEP_LATEST})
	if err != nil {
		t.Fatal(err)
	}
	if response.Mode != ctl.CacheCleanMode_CACHE_CLEAN_MODE_KEEP_LATEST || response.RemovedFiles != 1 || response.RemovedBytes <= 0 {
		t.Fatalf("unexpected response: %#v", response)
	}
	if len(response.Caches) != 1 || response.Caches[0].Files != 1 {
		t.Fatalf("unexpected caches after cleanup: %#v", response.Caches)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(newest) {
		t.Fatalf("unexpected remaining files: %#v", entries)
	}
}

func TestCleanCachesRejectsUnspecifiedMode(t *testing.T) {
	server := &Server{ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.CleanCaches(context.Background(), &ctl.CleanCachesRequest{})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestCleanCachesWithoutImageBuilder(t *testing.T) {
	_, err := (&Server{Logger: silentLogger()}).CleanCaches(context.Background(), &ctl.CleanCachesRequest{Mode: ctl.CacheCleanMode_CACHE_CLEAN_MODE_ALL})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}
