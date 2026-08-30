// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"context"
	"strings"
	"testing"
)

func TestContainerfileInstallsPackagesWithoutInlineCache(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "archlinux", PackageManager: "pacman", Packages: []string{"git", "python"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(file, "--mount") || !strings.Contains(file, "git python") {
		t.Fatalf("unexpected Containerfile: %s", file)
	}
}
func TestContainerfileRejectsCommandInjection(t *testing.T) {
	if _, err := Containerfile(BuildSpec{From: "arch", PackageManager: "pacman", Packages: []string{"git;rm"}}); err == nil {
		t.Fatal("accepted invalid package")
	}
}

func TestContainerfileLeavesCacheMountToBuildOptions(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "archlinux", PackageManager: "pacman"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(file, "--mount") || strings.Contains(file, "type=cache") {
		t.Fatalf("Containerfile contains an inline cache mount: %s", file)
	}
	if strings.Contains(file, "pacman -Scc") {
		t.Fatalf("Containerfile cleans the persistent pacman cache: %s", file)
	}
}

func TestContainerfileUsesBaseImage(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "docker.io/library/archlinux:latest", PackageManager: "pacman"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(file, "FROM docker.io/library/archlinux:latest") {
		t.Fatalf("base image not first line: %s", file)
	}
}

func TestContainerfileWithoutPackagesRunsPlainUpdate(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "arch", PackageManager: "pacman"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "RUN pacman -Syu --needed --noconfirm\n") {
		t.Fatalf("missing plain update line: %s", file)
	}
}

func TestContainerfileSetsGuestAgentEntrypoint(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "arch", PackageManager: "pacman", IsBase: true, GuestAgent: GuestAgentImage{Image: "localhost/dsh-podman-guest-agent:latest"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "ENTRYPOINT") {
		t.Fatalf("missing entrypoint: %s", file)
	}
}

func TestContainerfileRejectsShellMetacharacters(t *testing.T) {
	for _, pkg := range []string{"a b", "$(id)", "`id`", "a&b", "a|b", "a;b", "a>b", "a\nb", "~evil"} {
		if _, err := Containerfile(BuildSpec{From: "arch", PackageManager: "pacman", Packages: []string{pkg}}); err == nil {
			t.Errorf("accepted invalid package %q", pkg)
		}
	}
}

func TestContainerfileRejectsFlagPackages(t *testing.T) {
	for _, pkg := range []string{"-S", "--noconfirm", "--dbpath", "-R"} {
		if _, err := Containerfile(BuildSpec{From: "arch", PackageManager: "pacman", Packages: []string{pkg}}); err == nil {
			t.Errorf("accepted flag-like package %q", pkg)
		}
	}
}

func TestContainerfileAcceptsValidPackages(t *testing.T) {
	for _, pkg := range []string{"git", "base-devel", "python3.12", "g++", "linux-headers"} {
		if _, err := Containerfile(BuildSpec{From: "arch", PackageManager: "pacman", Packages: []string{pkg}}); err != nil {
			t.Errorf("rejected valid package %q: %v", pkg, err)
		}
	}
}

func TestContainerfileRejectsInvalidBaseImage(t *testing.T) {
	for _, base := range []string{"", "..", "../etc", "arch\nRUN touch /escape", "arch:latest #evil", "arch 1.0", "a\\b", "arch\n", "::"} {
		if _, err := Containerfile(BuildSpec{From: base, PackageManager: "pacman"}); err == nil {
			t.Errorf("accepted invalid base image %q", base)
		}
	}
}

func TestContainerfileAcceptsValidBaseImages(t *testing.T) {
	for _, base := range []string{"archlinux", "docker.io/library/archlinux:latest", "localhost/team/image:1.0", "registry.example.com/ns/img@sha256:abc123", "archlinux-1"} {
		if _, err := Containerfile(BuildSpec{From: base, PackageManager: "pacman"}); err != nil {
			t.Errorf("rejected valid base image %q: %v", base, err)
		}
	}
}

func TestContainerfileRejectsUnknownPackageManager(t *testing.T) {
	for _, pm := range []string{"", "yum", "pkg"} {
		if _, err := Containerfile(BuildSpec{From: "arch", PackageManager: pm}); err == nil {
			t.Errorf("accepted unknown package manager %q", pm)
		}
	}
}

func TestValidImageID(t *testing.T) {
	for _, id := range []string{"arch", "a-b_c.1", "A1", "x", "localhost/dsh-podman/arch-base", "registry.example.com/dsh/my-image", "localhost/dsh-podman/arch-base:v2", "my-image:v1"} {
		if !validImageID(id) {
			t.Errorf("rejected valid image id %q", id)
		}
	}
	for _, id := range []string{"", ".", "..", "-x", "a b", "a@sha256:abc", "a\nb", "a/../b", "../etc", "a\\b", strings.Repeat("b", 160)} {
		if validImageID(id) {
			t.Errorf("accepted invalid image id %q", id)
		}
	}
}

func TestTagFor(t *testing.T) {
	builder := Builder{ImagePrefix: "localhost/dsh-podman/", BaseImagePrefix: "localhost/dsh-podman/base/"}
	if got := builder.tagFor("my-image", false); got != "localhost/dsh-podman/my-image:latest" {
		t.Fatalf("tagFor(custom) = %q", got)
	}
	if got := builder.tagFor("archlinux", true); got != "localhost/dsh-podman/base/archlinux:latest" {
		t.Fatalf("tagFor(base) = %q", got)
	}
}

func TestTagForNormalizesPrefix(t *testing.T) {
	builder := Builder{ImagePrefix: "registry.example.com/dsh", BaseImagePrefix: "reg.example.com/base"}
	if got := builder.tagFor("my-image", false); got != "registry.example.com/dsh/my-image:latest" {
		t.Fatalf("unexpected custom tag %q", got)
	}
	if got := builder.tagFor("archlinux", true); got != "reg.example.com/base/archlinux:latest" {
		t.Fatalf("unexpected base tag %q", got)
	}
	empty := Builder{}
	if got := empty.tagFor("my-image", false); got != "localhost/dsh-podman/my-image:latest" {
		t.Fatalf("unexpected default custom tag %q", got)
	}
	if got := empty.tagFor("archlinux", true); got != "localhost/dsh-podman/base/archlinux:latest" {
		t.Fatalf("unexpected default base tag %q", got)
	}
}

func TestBuildRejectsInvalidImageID(t *testing.T) {
	builder := Builder{}
	for _, id := range []string{"../../etc", "..", "a/b", ""} {
		if _, err := builder.Build(BuildSpec{ImageID: id, From: "arch", PackageManager: "pacman"}); err == nil {
			t.Errorf("accepted invalid image id %q", id)
		}
	}
}

func TestBuildRequiresPacmanCacheOnly(t *testing.T) {
	builder := Builder{Context: context.Background(), StateDir: t.TempDir()}
	_, err := builder.Build(BuildSpec{ImageID: "dev", From: "ubuntu", PackageManager: "apt"})
	if err == nil {
		t.Fatal("expected apt build to fail without a podman connection")
	}
	if strings.Contains(err.Error(), "pacman cache path") {
		t.Fatalf("apt build must not require the pacman cache: %v", err)
	}
	_, err = builder.Build(BuildSpec{ImageID: "dev", From: "archlinux", PackageManager: "pacman"})
	if err == nil {
		t.Fatal("expected pacman build to fail")
	}
	if !strings.Contains(err.Error(), "pacman cache path must be an absolute path") {
		t.Fatalf("pacman build should require an absolute cache path: %v", err)
	}
}

func TestContainerfileWithoutGuestAgentImageIsUnchanged(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "archlinux", PackageManager: "pacman", Packages: []string{"git"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(file, "guestagent") {
		t.Fatalf("unexpected multi-stage build: %s", file)
	}
	if !strings.HasPrefix(file, "FROM archlinux\n") {
		t.Fatalf("expected plain FROM first: %s", file)
	}
}

func TestContainerfileBakesGuestAgentBinary(t *testing.T) {
	guest := GuestAgentImage{Image: "localhost/dsh-podman-guest-agent:latest", AgentBin: "/bin/dsh-podman-guest-agent", DestAgentBin: "/usr/local/bin/dsh-podman-guest-agent"}
	file, err := Containerfile(BuildSpec{From: "archlinux", PackageManager: "pacman", IsBase: true, GuestAgent: guest})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "FROM localhost/dsh-podman-guest-agent:latest AS guestagent\n") {
		t.Fatalf("missing guestagent stage: %s", file)
	}
	if !strings.Contains(file, "COPY --from=guestagent /bin/dsh-podman-guest-agent /usr/local/bin/dsh-podman-guest-agent") {
		t.Fatalf("missing binary copy: %s", file)
	}
	if !strings.Contains(file, "ENTRYPOINT [\"/usr/local/bin/dsh-podman-guest-agent\"]") {
		t.Fatalf("missing entrypoint: %s", file)
	}
}

func TestContainerfileGuestAgentUsesDefaults(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "archlinux", PackageManager: "pacman", IsBase: true, GuestAgent: GuestAgentImage{Image: "localhost/dsh-podman-guest-agent:latest"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "COPY --from=guestagent /bin/dsh-podman-guest-agent /usr/local/bin/dsh-podman-guest-agent") {
		t.Fatalf("defaults not applied: %s", file)
	}
}

func TestContainerfileGuestAgentEntrypointFollowsDestination(t *testing.T) {
	guest := GuestAgentImage{Image: "localhost/dsh-podman-guest-agent:latest", AgentBin: "/bin/dsh-podman-guest-agent", DestAgentBin: "/opt/dsh/guest-agent"}
	file, err := Containerfile(BuildSpec{From: "archlinux", PackageManager: "pacman", IsBase: true, GuestAgent: guest})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "COPY --from=guestagent /bin/dsh-podman-guest-agent /opt/dsh/guest-agent") {
		t.Fatalf("missing copy to custom destination: %s", file)
	}
	if !strings.Contains(file, "ENTRYPOINT [\"/opt/dsh/guest-agent\"]") {
		t.Fatalf("entrypoint does not follow destination: %s", file)
	}
}

func TestContainerfileRejectsInvalidGuestAgentConfig(t *testing.T) {
	valid := GuestAgentImage{Image: "localhost/dsh-podman-guest-agent:latest", AgentBin: "/bin/dsh-podman-guest-agent", DestAgentBin: "/usr/local/bin/dsh-podman-guest-agent"}
	cases := []GuestAgentImage{
		{Image: "arch\nRUN evil", AgentBin: "/bin/x", DestAgentBin: "/bin/x"},
		{Image: "..", AgentBin: "/bin/x", DestAgentBin: "/bin/x"},
		{Image: "", AgentBin: "/bin/x", DestAgentBin: "/bin/x"},
		{Image: "img", AgentBin: "relative", DestAgentBin: "/bin/x"},
		{Image: "img", AgentBin: "/a/../b", DestAgentBin: "/bin/x"},
		{Image: "img", AgentBin: "/bin/x", DestAgentBin: "/usr/bin/x y"},
		{Image: "img", AgentBin: "/bin/x", DestAgentBin: "/usr/bin/x\"\nRUN evil"},
	}
	for _, guest := range cases {
		if _, err := Containerfile(BuildSpec{From: "arch", PackageManager: "pacman", IsBase: true, GuestAgent: guest}); err == nil {
			t.Errorf("accepted invalid guest agent config %#v", guest)
		}
	}
	if _, err := Containerfile(BuildSpec{From: "arch", PackageManager: "pacman", IsBase: true, GuestAgent: valid}); err != nil {
		t.Errorf("rejected valid guest agent config: %v", err)
	}
}

func TestContainerfileBaseDistros(t *testing.T) {
	guest := GuestAgentImage{Image: "localhost/dsh-podman-guest-agent:latest", AgentBin: "/bin/dsh-podman-guest-agent", DestAgentBin: "/usr/local/bin/dsh-podman-guest-agent"}
	cases := []struct {
		name        string
		spec        BuildSpec
		wantFrom    string
		wantInstall string
		wantPost    string
	}{
		{
			name: "archlinux", wantFrom: "FROM docker.io/library/archlinux:latest\n",
			spec:        BuildSpec{ImageID: "archlinux", From: "docker.io/library/archlinux:latest", PackageManager: "pacman", Packages: []string{"base-devel", "git", "python", "curl", "wget", "openssh", "ca-certificates", "ripgrep", "fd", "jq", "unzip", "zstd", "less", "procps-ng", "diffutils", "patch", "tree"}, IsBase: true, GuestAgent: guest},
			wantInstall: "RUN pacman -Syu --needed --noconfirm base-devel git python curl wget openssh ca-certificates ripgrep fd jq unzip zstd less procps-ng diffutils patch tree\n",
		},
		{
			name: "ubuntu", wantFrom: "FROM docker.io/library/ubuntu:latest\n",
			spec:        BuildSpec{ImageID: "ubuntu", From: "docker.io/library/ubuntu:latest", PackageManager: "apt", Packages: []string{"build-essential", "ca-certificates", "curl", "diffutils", "fd-find", "git", "jq", "less", "openssh-client", "patch", "procps", "python3", "ripgrep", "tree", "unzip", "wget", "zstd"}, IsBase: true, PostInstall: []string{"ln -s /usr/bin/fd-find /usr/local/bin/fd"}, GuestAgent: guest},
			wantInstall: "RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential ca-certificates curl diffutils fd-find git jq less openssh-client patch procps python3 ripgrep tree unzip wget zstd && rm -rf /var/lib/apt/lists/*\n",
			wantPost:    "RUN ln -s /usr/bin/fd-find /usr/local/bin/fd\n",
		},
		{
			name: "alpine", wantFrom: "FROM docker.io/library/alpine:latest\n",
			spec:        BuildSpec{ImageID: "alpine", From: "docker.io/library/alpine:latest", PackageManager: "apk", Packages: []string{"bash", "build-base", "ca-certificates", "curl", "diffutils", "fd", "git", "jq", "less", "openssh-client", "patch", "procps", "python3", "ripgrep", "tree", "unzip", "wget", "zstd"}, IsBase: true, GuestAgent: guest},
			wantInstall: "RUN apk add --no-cache bash build-base ca-certificates curl diffutils fd git jq less openssh-client patch procps python3 ripgrep tree unzip wget zstd\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			file, err := Containerfile(tc.spec)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(file, tc.wantFrom) {
				t.Fatalf("unexpected FROM: want prefix %q, got:\n%s", tc.wantFrom, file)
			}
			if !strings.Contains(file, tc.wantInstall) {
				t.Fatalf("missing install line %q, got:\n%s", tc.wantInstall, file)
			}
			if tc.wantPost != "" && !strings.Contains(file, tc.wantPost) {
				t.Fatalf("missing post-install line %q, got:\n%s", tc.wantPost, file)
			}
			if !strings.Contains(file, "COPY --from=guestagent /bin/dsh-podman-guest-agent /usr/local/bin/dsh-podman-guest-agent") || !strings.Contains(file, "ENTRYPOINT [\"/usr/local/bin/dsh-podman-guest-agent\"]") {
				t.Fatalf("base build must bake the guest agent, got:\n%s", file)
			}
		})
	}
	// Custom builds never carry the guest-agent stage.
	custom, err := Containerfile(BuildSpec{ImageID: "dev", From: "localhost/dsh-podman/base/archlinux:latest", PackageManager: "pacman", Packages: []string{"git"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(custom, "guestagent") || strings.Contains(custom, "ENTRYPOINT") {
		t.Fatalf("custom build must not bake the guest agent: %s", custom)
	}
}

func TestBaseImageByID(t *testing.T) {
	for _, id := range []string{"archlinux", "ubuntu", "alpine"} {
		base, ok := BaseImageByID(id)
		if !ok || base.ID != id {
			t.Errorf("expected base image %q, got %#v", id, base)
		}
	}
	for _, id := range []string{"", "arch", "debian", "fedora"} {
		if _, ok := BaseImageByID(id); ok {
			t.Errorf("unexpectedly found base image %q", id)
		}
	}
}

func TestBaseImagesRegistry(t *testing.T) {
	if len(BaseImages) != 3 {
		t.Fatalf("expected 3 base images, got %d", len(BaseImages))
	}
	if BaseImages[0].ID != "archlinux" || BaseImages[0].Primitive != "docker.io/library/archlinux:latest" || BaseImages[0].PackageManager != "pacman" || BaseImages[0].CachePath != "/var/cache/pacman/pkg" {
		t.Fatalf("unexpected archlinux base: %#v", BaseImages[0])
	}
	if BaseImages[1].ID != "ubuntu" || BaseImages[1].Primitive != "docker.io/library/ubuntu:latest" || BaseImages[1].PackageManager != "apt" || len(BaseImages[1].PostInstall) != 1 || BaseImages[1].PostInstall[0] != "ln -s /usr/bin/fd-find /usr/local/bin/fd" {
		t.Fatalf("unexpected ubuntu base: %#v", BaseImages[1])
	}
	if BaseImages[2].ID != "alpine" || BaseImages[2].Primitive != "docker.io/library/alpine:latest" || BaseImages[2].PackageManager != "apk" || BaseImages[2].CachePath != "" {
		t.Fatalf("unexpected alpine base: %#v", BaseImages[2])
	}
}
