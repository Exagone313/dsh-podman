// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"context"
	"strings"
	"testing"
)

// The harness releases below are deliberately fake: the tests exercise the
// version they are handed, so a real release bump must never change them.
const (
	testDSHVersion      = "0.0.0"
	testOtherDSHVersion = "0.0.1"
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
		builder := Builder{Context: context.Background()}
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
		builder := Builder{Context: context.Background()}
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
			wantInstall: "RUN sed -i '/Post-Invoke/d' /etc/apt/apt.conf.d/docker-clean && printf 'APT::Keep-Downloaded-Packages \"true\";\\n' > /etc/apt/apt.conf.d/99dsh-podman-keep && DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential ca-certificates curl diffutils fd-find git jq less netcat-openbsd openssh-client patch procps python3 ripgrep tree unzip wget zstd && rm -rf /var/lib/apt/lists/*\n",
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
	for _, id := range []string{"", "arch", "debian", "fedora", "ptc"} {
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

func TestPTCImageIDDoesNotCarryTheVersion(t *testing.T) {
	if id := PTCImageID(); id != "ptc" {
		t.Fatalf("unexpected PTC image id %q", id)
	}
	// Every release shares the one name; only the labels differ.
	for _, version := range []string{testDSHVersion, testOtherDSHVersion} {
		spec, err := PTCBuildSpec(version)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(spec.ImageID, version) || spec.ImageID != PTCImageID() {
			t.Fatalf("the PTC image id %q carries the version %q", spec.ImageID, version)
		}
	}
}

func TestPTCImageLabelsRejectUnsafeVersions(t *testing.T) {
	for _, version := range []string{
		"",
		" ",
		"0.0.0;rm -rf /",
		"0.0.0; rm -rf /",
		"../escape",
		"0.0.0/../x",
		"0.0.0\\x",
		"0.0.0\nRUN true",
		"0.0.0 rc",
		"0.0.0@sha256:abc",
		"UPPER",
		"1..2",
		"-1.0.0",
		"1.0.0/",
		strings.Repeat("a", 101),
	} {
		if _, err := PTCImageLabels(version); err == nil {
			t.Errorf("accepted invalid dsh version %q", version)
		}
	}
	for _, version := range []string{"1", "0.0.0", "0.0.0-test", "0.0.0-beta.1"} {
		if _, err := PTCImageLabels(version); err != nil {
			t.Errorf("rejected valid dsh version %q: %v", version, err)
		}
	}
}

func TestPTCImageTagIsSingleAndDeterministic(t *testing.T) {
	builder := Builder{ImagePrefix: "localhost/dsh-podman/"}
	tag := builder.PTCImageTag()
	if tag != "localhost/dsh-podman/ptc:latest" {
		t.Fatalf("unexpected PTC tag %q", tag)
	}
	// Every workspace and every release resolves to the same image.
	if same := (&Builder{ImagePrefix: "localhost/dsh-podman/"}).PTCImageTag(); same != tag {
		t.Fatalf("the PTC tag is not deterministic: %q vs %q", tag, same)
	}
	if defaultTag := (&Builder{}).PTCImageTag(); defaultTag != tag {
		t.Fatalf("unexpected default PTC tag %q", defaultTag)
	}
}

func TestPTCContainerfileUsesExactlyTheSuppliedVersion(t *testing.T) {
	spec, err := PTCBuildSpec(testDSHVersion)
	if err != nil {
		t.Fatal(err)
	}
	if spec.ImageID != "ptc" || spec.IsBase || spec.PackageManager != "apt" {
		t.Fatalf("unexpected PTC build spec: %#v", spec)
	}
	if spec.Labels[PTCVersionLabel] != testDSHVersion {
		t.Fatalf("the PTC image must label its release: %#v", spec.Labels)
	}
	file, err := Containerfile(spec)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(file, "FROM "+PTCBasePrimitive+"\n") {
		t.Fatalf("PTC image must build from its primitive, got:\n%s", file)
	}
	if PTCBasePrimitive != "docker.io/library/node:26-slim" {
		t.Fatalf("the PTC base must build from the node:26-slim tag, got %q", PTCBasePrimitive)
	}
	if strings.Contains(PTCBasePrimitive, "@") {
		t.Fatalf("the PTC base must not pin a single-platform digest, got %q", PTCBasePrimitive)
	}
	// The apt build path is what makes the build use the managed apt cache.
	if !strings.Contains(file, "apt-get update") || !strings.Contains(file, "apt-get install -y --no-install-recommends") {
		t.Fatalf("PTC image must use the apt build path, got:\n%s", file)
	}
	wantInstall := "RUN npm install -g " + ptcRuntimePackage + "@" + testDSHVersion + "\n"
	if !strings.Contains(file, wantInstall) {
		t.Fatalf("PTC image must install the supplied PTC runtime version %q, got:\n%s", wantInstall, file)
	}
	wantLink := "RUN mkdir -p /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai && ln -s /usr/local/lib/node_modules/" + ptcRuntimePackage + " /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/" + ptcRuntimePackageName + "\n"
	if !strings.Contains(file, wantLink) {
		t.Fatalf("PTC image must scaffold the host's expected path, want %q, got:\n%s", wantLink, file)
	}
	// No dsh CLI, no dsh tree, and no patched dsh in the PTC image.
	for _, forbidden := range []string{"@deepseek-ai/dsh@", "dsh-host-webserver", "patch-wildcard-host"} {
		if strings.Contains(file, forbidden) {
			t.Fatalf("PTC image must not carry %q, got:\n%s", forbidden, file)
		}
	}
	// A different version builds a different Containerfile, not the same one.
	otherSpec, err := PTCBuildSpec(testOtherDSHVersion)
	if err != nil {
		t.Fatal(err)
	}
	otherFile, err := Containerfile(otherSpec)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(otherFile, testDSHVersion) {
		t.Fatalf("the Containerfile must use the supplied version, got:\n%s", otherFile)
	}
	if !strings.Contains(otherFile, "RUN npm install -g "+ptcRuntimePackage+"@"+testOtherDSHVersion+"\n") {
		t.Fatalf("unexpected Containerfile for %s:\n%s", testOtherDSHVersion, otherFile)
	}
}

func TestPTCImageLabelsCoverTheReleaseAndRecipe(t *testing.T) {
	spec, err := PTCBuildSpec(testDSHVersion)
	if err != nil {
		t.Fatal(err)
	}
	file, err := Containerfile(spec)
	if err != nil {
		t.Fatal(err)
	}
	if spec.Labels[PTCVersionLabel] != testDSHVersion {
		t.Fatalf("unexpected version label: %#v", spec.Labels)
	}
	if spec.Labels[PTCRecipeLabel] != recipeDigest(file) {
		t.Fatalf("the recipe label must digest the rendered Containerfile: %#v", spec.Labels)
	}
	// A changed recipe changes the digest, so the same release rebuilds.
	changed := spec
	changed.PostInstall = append(append([]string(nil), spec.PostInstall...), "true")
	changedFile, err := Containerfile(changed)
	if err != nil {
		t.Fatal(err)
	}
	if recipeDigest(changedFile) == spec.Labels[PTCRecipeLabel] {
		t.Fatal("a changed recipe must change the Containerfile digest")
	}
	// The same release with the same recipe yields identical labels, so the
	// image is reused.
	same, err := PTCImageLabels(testDSHVersion)
	if err != nil {
		t.Fatal(err)
	}
	if LabelFingerprint(same) != LabelFingerprint(spec.Labels) {
		t.Fatalf("the same release and recipe must yield the same labels: %#v vs %#v", same, spec.Labels)
	}
	other, err := PTCImageLabels(testOtherDSHVersion)
	if err != nil {
		t.Fatal(err)
	}
	if LabelFingerprint(other) == LabelFingerprint(spec.Labels) {
		t.Fatal("a different release must yield different labels")
	}
}

func TestPTCBuildSpecRejectsUnsafeVersions(t *testing.T) {
	for _, version := range []string{"", "0.0.0; rm -rf /", "../escape", "0.0.0\nRUN true"} {
		if _, err := PTCBuildSpec(version); err == nil {
			t.Errorf("accepted invalid dsh version %q", version)
		}
		if _, err := PTCImageLabels(version); err == nil {
			t.Errorf("accepted invalid dsh version %q for labels", version)
		}
	}
}
