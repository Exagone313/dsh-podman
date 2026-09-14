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

func TestBuildCachesAreOptional(t *testing.T) {
	for _, pm := range []string{"pacman", "apt", "apk"} {
		builder := Builder{Context: context.Background(), StateDir: t.TempDir()}
		_, err := builder.Build(BuildSpec{ImageID: "dev", From: "arch", PackageManager: pm})
		if err == nil {
			t.Fatalf("%s build with no cache should fail (no podman connection)", pm)
		}
		if strings.Contains(err.Error(), "cache path must be an absolute path") {
			t.Fatalf("%s build without a cache must not require one: %v", pm, err)
		}
	}
}

func TestBuildRejectsRelativeCachePath(t *testing.T) {
	cases := []struct {
		pm  string
		set func(b *Builder)
	}{
		{"pacman", func(b *Builder) { b.HostPacmanCache = "relative/path" }},
		{"apt", func(b *Builder) { b.HostAptCache = "relative/path" }},
		{"apk", func(b *Builder) { b.HostApkCache = "relative/path" }},
	}
	for _, tc := range cases {
		builder := Builder{Context: context.Background(), StateDir: t.TempDir()}
		tc.set(&builder)
		_, err := builder.Build(BuildSpec{ImageID: "dev", From: "arch", PackageManager: tc.pm})
		if err == nil {
			t.Fatalf("%s build with a relative cache should fail", tc.pm)
		}
		if !strings.Contains(err.Error(), tc.pm+" cache path must be an absolute path") {
			t.Fatalf("%s build should reject a relative cache path: %v", tc.pm, err)
		}
	}
}

func TestContainerfileApkCachingVariant(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "alpine", PackageManager: "apk", Packages: []string{"git"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "RUN apk upgrade --no-cache && apk add --no-cache git") {
		t.Fatalf("default apk build should use --no-cache: %s", file)
	}
	if strings.Contains(file, "--cache-packages") || strings.Contains(file, "--update-cache") {
		t.Fatalf("default apk build must not enable caching: %s", file)
	}
	file, err = Containerfile(BuildSpec{From: "alpine", PackageManager: "apk", Packages: []string{"git"}, CachePackages: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "RUN apk upgrade --cache-packages --update-cache && apk add --cache-packages --update-cache git") {
		t.Fatalf("caching apk build should use --cache-packages --update-cache: %s", file)
	}
	if strings.Contains(file, "--no-cache") {
		t.Fatalf("caching apk build must not use --no-cache: %s", file)
	}
}

func TestContainerfileAptUnchangedByCaching(t *testing.T) {
	for _, cache := range []bool{false, true} {
		file, err := Containerfile(BuildSpec{From: "ubuntu", PackageManager: "apt", Packages: []string{"git"}, CachePackages: cache})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(file, "apt-get install") {
			t.Fatalf("unexpected apt Containerfile: %s", file)
		}
		if strings.Contains(file, "--cache-packages") || strings.Contains(file, "--update-cache") {
			t.Fatalf("apt Containerfile must not contain apk cache flags: %s", file)
		}
	}
}

func TestContainerfileBaseBuildDoesNotReferenceGuestAgent(t *testing.T) {
	file, err := Containerfile(BuildSpec{From: "archlinux", PackageManager: "pacman", Packages: []string{"git"}, IsBase: true})
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

func TestContainerfileBaseDistros(t *testing.T) {
	cases := []struct {
		name        string
		spec        BuildSpec
		wantFrom    string
		wantInstall string
		wantPost    string
	}{
		{
			name: "archlinux", wantFrom: "FROM docker.io/library/archlinux:latest\n",
			spec:        BuildSpec{ImageID: "archlinux", From: "docker.io/library/archlinux:latest", PackageManager: "pacman", Packages: []string{"base-devel", "ca-certificates", "curl", "diffutils", "fd", "git", "inetutils", "jq", "less", "openbsd-netcat", "openssh", "patch", "procps-ng", "python", "ripgrep", "tree", "unzip", "wget", "zstd"}, IsBase: true},
			wantInstall: "RUN pacman -Syu --needed --noconfirm base-devel ca-certificates curl diffutils fd git inetutils jq less openbsd-netcat openssh patch procps-ng python ripgrep tree unzip wget zstd\n",
		},
		{
			name: "ubuntu", wantFrom: "FROM docker.io/library/ubuntu:latest\n",
			spec:        BuildSpec{ImageID: "ubuntu", From: "docker.io/library/ubuntu:latest", PackageManager: "apt", Packages: []string{"build-essential", "ca-certificates", "curl", "diffutils", "fd-find", "git", "jq", "less", "netcat-openbsd", "openssh-client", "patch", "procps", "python3", "ripgrep", "tree", "unzip", "wget", "zstd"}, IsBase: true, PostInstall: []string{"ln -s /usr/bin/fd-find /usr/local/bin/fd"}},
			wantInstall: "RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential ca-certificates curl diffutils fd-find git jq less netcat-openbsd openssh-client patch procps python3 ripgrep tree unzip wget zstd && rm -rf /var/lib/apt/lists/*\n",
			wantPost:    "RUN ln -s /usr/bin/fd-find /usr/local/bin/fd\n",
		},
		{
			name: "alpine", wantFrom: "FROM docker.io/library/alpine:latest\n",
			spec:        BuildSpec{ImageID: "alpine", From: "docker.io/library/alpine:latest", PackageManager: "apk", Packages: []string{"bash", "build-base", "ca-certificates", "curl", "diffutils", "fd", "git", "jq", "less", "openssh-client", "patch", "procps", "python3", "ripgrep", "tree", "unzip", "wget", "zstd"}, IsBase: true},
			wantInstall: "RUN apk upgrade --no-cache && apk add --no-cache bash build-base ca-certificates curl diffutils fd git jq less openssh-client patch procps python3 ripgrep tree unzip wget zstd\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			file, err := Containerfile(tc.spec)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(file, tc.wantFrom) {
				t.Fatalf("unexpected first line: want %q, got:\n%s", tc.wantFrom, file)
			}
			if !strings.Contains(file, tc.wantInstall) {
				t.Fatalf("missing install line %q, got:\n%s", tc.wantInstall, file)
			}
			if tc.wantPost != "" && !strings.Contains(file, tc.wantPost) {
				t.Fatalf("missing post-install line %q, got:\n%s", tc.wantPost, file)
			}
		})
	}
	// No build carries a guest-agent stage anymore.
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
	if BaseImages[1].ID != "ubuntu" || BaseImages[1].Primitive != "docker.io/library/ubuntu:latest" || BaseImages[1].PackageManager != "apt" || BaseImages[1].CachePath != "/var/cache/apt/archives" || len(BaseImages[1].PostInstall) != 1 || BaseImages[1].PostInstall[0] != "ln -s /usr/bin/fd-find /usr/local/bin/fd" {
		t.Fatalf("unexpected ubuntu base: %#v", BaseImages[1])
	}
	if BaseImages[2].ID != "alpine" || BaseImages[2].Primitive != "docker.io/library/alpine:latest" || BaseImages[2].PackageManager != "apk" || BaseImages[2].CachePath != "/etc/apk/cache" {
		t.Fatalf("unexpected alpine base: %#v", BaseImages[2])
	}
}
