// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"testing"
)

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