// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"slices"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
)

func TestSetPathsReplacesAndDeduplicates(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	server := New()
	response, err := server.SetPaths(context.Background(), &guest.SetPathsRequest{Paths: []string{"/opt/bin", "/b", "/opt/bin", ""}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(response.GetPaths(), []string{"/opt/bin", "/b"}) {
		t.Fatalf("unexpected stored paths: %q", response.GetPaths())
	}
	if response.GetDefaultPath() != "/usr/bin" {
		t.Fatalf("unexpected default path: %q", response.GetDefaultPath())
	}
	got, err := server.GetPaths(context.Background(), &guest.GetPathsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got.GetPaths(), []string{"/opt/bin", "/b"}) {
		t.Fatalf("GetPaths did not report the stored paths: %q", got.GetPaths())
	}
	if got.GetDefaultPath() != "/usr/bin" {
		t.Fatalf("GetPaths default path: %q", got.GetDefaultPath())
	}
	// A later call replaces the whole list.
	replaced, err := server.SetPaths(context.Background(), &guest.SetPathsRequest{Paths: []string{"/only"}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(replaced.GetPaths(), []string{"/only"}) {
		t.Fatalf("paths were not replaced: %q", replaced.GetPaths())
	}
}
