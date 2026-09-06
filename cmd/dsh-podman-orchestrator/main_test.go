// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRequireDirectory covers the control socket's directory: the socket is
// created 0600, but that is only meaningful while the directory above it stays
// private to its owner.
func TestRequireDirectory(t *testing.T) {
	root := t.TempDir()
	private := filepath.Join(root, "private")
	if err := os.Mkdir(private, 0700); err != nil {
		t.Fatal(err)
	}
	if err := requireDirectory(private); err != nil {
		t.Fatalf("private directory rejected: %v", err)
	}
	for _, mode := range []os.FileMode{0750, 0705, 0777, 0770} {
		open := filepath.Join(root, "open")
		if err := os.Mkdir(open, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(open, mode); err != nil {
			t.Fatal(err)
		}
		if err := requireDirectory(open); err == nil {
			t.Errorf("accepted socket root with mode %04o", mode)
		}
		if err := os.Remove(open); err != nil {
			t.Fatal(err)
		}
	}
	if err := requireDirectory(filepath.Join(root, "missing")); err == nil {
		t.Error("accepted a missing socket root")
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := requireDirectory(file); err == nil {
		t.Error("accepted a file as the socket root")
	}
}

func TestImageRefWithTag(t *testing.T) {
	cases := []struct {
		name string
		ref  string
		tag  string
		want string
	}{
		{"replace tag", "ghcr.io/exagone313/dsh-podman/guest-agent:latest", "0.1.0", "ghcr.io/exagone313/dsh-podman/guest-agent:0.1.0"},
		{"append tag", "ghcr.io/exagone313/dsh-podman/guest-agent", "0.1.0", "ghcr.io/exagone313/dsh-podman/guest-agent:0.1.0"},
		{"bare name replace", "guest-agent:latest", "0.1.0", "guest-agent:0.1.0"},
		{"bare name append", "guest-agent", "0.1.0", "guest-agent:0.1.0"},
		{"registry port not a tag", "localhost:5000/guest-agent", "0.1.0", "localhost:5000/guest-agent:0.1.0"},
	}
	for _, tc := range cases {
		if got := imageRefWithTag(tc.ref, tc.tag); got != tc.want {
			t.Errorf("%s: imageRefWithTag(%q, %q) = %q, want %q", tc.name, tc.ref, tc.tag, got, tc.want)
		}
	}
}

func TestImageRefWithTagRejectsDigest(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("imageRefWithTag should panic on a digest reference")
		}
	}()
	imageRefWithTag("ghcr.io/exagone313/dsh-podman/guest-agent@sha256:abc123", "0.1.0")
}

func TestGetenvBool(t *testing.T) {
	for _, value := range []string{"1", "true", "TRUE", "yes", "on"} {
		t.Setenv("DSH_TEST_BOOL", value)
		if !getenvBool("DSH_TEST_BOOL") {
			t.Errorf("expected %q to be truthy", value)
		}
	}
	for _, value := range []string{"", "0", "false", "no", "off", "banana"} {
		t.Setenv("DSH_TEST_BOOL", value)
		if getenvBool("DSH_TEST_BOOL") {
			t.Errorf("expected %q to be falsy", value)
		}
	}
}
