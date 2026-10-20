// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/opencontainers/runtime-spec/specs-go"
	"go.podman.io/podman/v6/pkg/specgen"
)

// ptcWorkspaceRoot mirrors the host's workspace directory in the live layout:
// the configured skill directory is a workspace path below it.
const ptcWorkspaceRoot = "/home/workspace"

// ptcTestClient is a client whose paths are set but which never talks to
// podman: newGuestSpec is pure.
func ptcTestClient() *Client {
	return &Client{
		socketRoot:      "/run/dsh-podman",
		hostSocketRoot:  "/host/sockets",
		projectRoot:     "/projects",
		guestAgentMount: "/opt/dsh-podman/guest-agent",
		guestAgentBin:   "/bin/dsh-podman-guest-agent",
		skillDir:        ptcWorkspaceRoot + "/.agents/skills",
	}
}

func TestPTCSpecShape(t *testing.T) {
	client := ptcTestClient()
	spec := client.newGuestSpec("", "dsh-podman-ptc", "localhost/dsh-podman/ptc:latest", "tok", nil, nil, nil, nil, nil, true)
	if spec.User != "0" {
		t.Fatalf("the PTC container must run its agent as root, got user %q", spec.User)
	}
	if spec.Pod != "" {
		t.Fatalf("the shared PTC container must not join a pod, got pod %q", spec.Pod)
	}
	if spec.NetNS.NSMode != specgen.NoNetwork {
		t.Fatalf("the PTC container must run with network mode none, got %q", spec.NetNS.NSMode)
	}
	// Drop every capability, then add back exactly the four the guest agent
	// needs: to switch a child to another uid/gid, and to create or repair
	// that child's home.
	if !slices.Equal(spec.CapDrop, []string{"ALL"}) {
		t.Fatalf("the PTC container must drop all capabilities: %#v", spec.CapDrop)
	}
	if !slices.Equal(spec.CapAdd, []string{"CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID"}) {
		t.Fatalf("the PTC container must add only CHOWN, DAC_OVERRIDE, SETUID and SETGID: %#v", spec.CapAdd)
	}
	// no-new-privileges: specgen's knob is NoNewPrivileges, which podman maps
	// to the no-new-privileges security option.
	if spec.NoNewPrivileges == nil || !*spec.NoNewPrivileges {
		t.Fatalf("the PTC container must set no-new-privileges")
	}
	if spec.Env[PTCModeEnv] != "true" {
		t.Fatalf("the PTC mode marker is missing: %v", spec.Env)
	}
	if spec.Env["DSH_PODMAN_GUEST_TOKEN"] != "tok" || spec.Env["DSH_PODMAN_GUEST_SOCKET"] != "/run/dsh-podman/dsh-podman-ptc/guest.sock" {
		t.Fatalf("the usual agent variables are missing: %v", spec.Env)
	}
	// No user environment: only the reserved orchestrator variables.
	for key := range spec.Env {
		if !strings.HasPrefix(key, "DSH_PODMAN_") {
			t.Fatalf("the PTC container carries a user variable %q: %v", key, spec.Env)
		}
	}
	// No secrets, volumes, or published ports.
	if len(spec.EnvSecrets) != 0 || len(spec.Secrets) != 0 || len(spec.Volumes) != 0 || len(spec.ImageVolumes) != 0 || len(spec.PortMappings) != 0 {
		t.Fatalf("the PTC container must carry no secrets, volumes, or ports: %#v", spec)
	}
	// No project mount: every bind comes from the agent or the writable
	// scratch, never from the projects root.
	for _, mount := range spec.Mounts {
		if mount.Type == "bind" && (mount.Source == "/projects" || strings.HasPrefix(mount.Source, "/projects/")) {
			t.Fatalf("the PTC container must have no project mount: %#v", mount)
		}
	}
	// The mounted set is exactly the agent socket, the /tmp and /var/tmp
	// scratch pair, and the spill. In particular the configured skill
	// directory — a workspace path — is absent, and so is the workspace
	// directory podman would create as scaffolding for that bind.
	wantDestinations := []string{
		filepath.Join(client.socketRoot, "dsh-podman-ptc"),
		"/tmp",
		"/var/tmp",
		spillRoot,
	}
	if len(spec.Mounts) != len(wantDestinations) {
		t.Fatalf("the PTC container must mount exactly %v, got %#v", wantDestinations, spec.Mounts)
	}
	byDestination := map[string]specs.Mount{}
	for _, mount := range spec.Mounts {
		if _, duplicate := byDestination[mount.Destination]; duplicate {
			t.Fatalf("the PTC container has two mounts at %q: %#v", mount.Destination, spec.Mounts)
		}
		byDestination[mount.Destination] = mount
	}
	for _, mount := range spec.Mounts {
		if mount.Destination == ptcWorkspaceRoot || strings.HasPrefix(mount.Destination, ptcWorkspaceRoot+"/") {
			t.Fatalf("the PTC container must not mount the workspace scaffolding at %q: %#v", mount.Destination, mount)
		}
		if mount.Source == client.skillDir || strings.HasPrefix(mount.Source, client.skillDir+"/") ||
			mount.Destination == client.skillDir || strings.HasPrefix(mount.Destination, client.skillDir+"/") {
			t.Fatalf("the PTC container must not mount the agent skill directory: %#v", mount)
		}
	}
	socket, ok := byDestination[filepath.Join(client.socketRoot, "dsh-podman-ptc")]
	if !ok || socket.Type != "bind" || socket.Source != filepath.Join(client.hostSocketRoot, "dsh-podman-ptc") || !hasOption(socket.Options, "rw") {
		t.Fatalf("the PTC socket mount is missing or wrong: %#v", spec.Mounts)
	}
	for _, destination := range []string{"/tmp", "/var/tmp", spillRoot} {
		mount, ok := byDestination[destination]
		if !ok || mount.Type != "tmpfs" {
			t.Fatalf("the PTC container is missing the %q tmpfs: %#v", destination, spec.Mounts)
		}
		if !hasOption(mount.Options, "size="+ptcTmpfsSize) {
			t.Fatalf("tmpfs %q is not size-capped: %#v", destination, mount.Options)
		}
	}
	// Writable scratch: the read-only tmpfs policy plus size-capped tmpfs on
	// /tmp, /var/tmp, and the spill mount.
	if spec.ReadOnlyFilesystem == nil || !*spec.ReadOnlyFilesystem {
		t.Fatalf("the PTC root filesystem must be read-only")
	}
	if spec.ReadWriteTmpfs == nil || !*spec.ReadWriteTmpfs {
		t.Fatalf("the PTC container must mount writable /run")
	}
	if len(spec.Command) != 1 || spec.Command[0] != "/opt/dsh-podman/guest-agent/bin/dsh-podman-guest-agent" {
		t.Fatalf("unexpected PTC command: %v", spec.Command)
	}
}

func TestGuestSpecKeepsUserEnvironment(t *testing.T) {
	client := ptcTestClient()
	env := map[string]string{"EDITOR": "vi"}
	spec := client.newGuestSpec("dsh-podman-slug", "dsh-podman-slug-default", "localhost/dsh-podman/base/archlinux:latest", "tok", nil, nil, nil, env, nil, false)
	if spec.User != "" {
		t.Fatalf("a guest container keeps the image user, got %q", spec.User)
	}
	if spec.Pod != "dsh-podman-slug" {
		t.Fatalf("a guest container joins its workspace pod, got %q", spec.Pod)
	}
	if spec.NetNS.NSMode == specgen.NoNetwork {
		t.Fatalf("a guest container keeps its pod's network namespace")
	}
	if len(spec.CapDrop) != 0 || len(spec.CapAdd) != 0 || spec.NoNewPrivileges != nil {
		t.Fatalf("the PTC hardening leaked into a guest container: %#v", spec)
	}
	if spec.Env["EDITOR"] != "vi" {
		t.Fatalf("the guest user environment is missing: %v", spec.Env)
	}
	if _, ok := spec.Env[PTCModeEnv]; ok {
		t.Fatalf("a guest container must not carry the PTC marker: %v", spec.Env)
	}
	// The guest spill mount stays uncapped: the size cap is PTC-only.
	for _, mount := range spec.Mounts {
		if mount.Type == "tmpfs" && mount.Destination == spillRoot && hasOption(mount.Options, "size="+ptcTmpfsSize) {
			t.Fatalf("a guest container must not cap the spill tmpfs: %#v", mount.Options)
		}
	}
	// The PTC exclusion is PTC-only: a workspace guest keeps its skill mount.
	foundSkill := false
	for _, mount := range spec.Mounts {
		if mount.Type == "bind" && mount.Source == client.skillDir && mount.Destination == client.skillDir && hasOption(mount.Options, "ro") {
			foundSkill = true
		}
	}
	if !foundSkill {
		t.Fatalf("a workspace guest container must keep its read-only skill mount: %#v", spec.Mounts)
	}
}
