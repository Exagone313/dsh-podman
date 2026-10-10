// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"strings"
	"testing"
)

const (
	testProjectRoot     = "/home/user/project"
	testSocketRoot      = "/run/dsh-podman"
	testGuestAgentMount = "/opt/dsh-podman/guest-agent"
	testGuestAgentBin   = "/opt/dsh-podman/guest-agent/bin/dsh-podman-guest-agent"
)

func validateTestSkillDir(dir string) error {
	return ValidateSkillDir(dir, testProjectRoot, testSocketRoot, testGuestAgentMount, testGuestAgentBin)
}

func TestValidateSkillDirAcceptsHostDirectories(t *testing.T) {
	for _, dir := range []string{
		"",
		"/home/user/.agents/skills",
		"/srv/skills",
		// Accepted on purpose: the Quadlet comment covers the DSH root.
		"/home/user/.dsh/skills",
	} {
		if err := validateTestSkillDir(dir); err != nil {
			t.Fatalf("expected %q to be accepted, got %v", dir, err)
		}
	}
}

func TestValidateSkillDirRejectsUnusablePaths(t *testing.T) {
	for _, dir := range []string{
		"home/user/.agents/skills",
		"/home/user/.agents/skills/",
		"/home/user/.agents/../skills",
	} {
		if err := validateTestSkillDir(dir); err == nil {
			t.Fatalf("expected %q to be refused", dir)
		}
	}
}

func TestValidateSkillDirRejectsReservedPaths(t *testing.T) {
	cases := map[string]string{
		"/":                      "reserved",
		"/tmp":                   "reserved",
		"/tmp/skills":            "lies inside",
		"/var/tmp":               "reserved",
		"/var/tmp/skills":        "lies inside",
		"/tmp/dsh-podman":        "reserved",
		"/tmp/dsh-podman/spill":  "lies inside",
		testProjectRoot:          "reserved",
		"/home/user/project/app": "lies inside",
		"/home/user":             "shadow",
		testSocketRoot:           "reserved",
		"/run/dsh-podman/guest":  "lies inside",
		testGuestAgentMount:      "reserved",
		"/opt/dsh-podman":        "shadow",
		testGuestAgentBin:        "reserved",
		testGuestAgentBin + "/x": "lies inside",
	}
	for dir, want := range cases {
		err := validateTestSkillDir(dir)
		if err == nil {
			t.Fatalf("expected %q to be refused", dir)
		}
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("expected %q to be refused with %q, got %v", dir, want, err)
		}
	}
}
