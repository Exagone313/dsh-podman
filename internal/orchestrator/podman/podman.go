// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/opencontainers/runtime-spec/specs-go"
	"go.podman.io/podman/v6/pkg/bindings"
	"go.podman.io/podman/v6/pkg/bindings/containers"
	"go.podman.io/podman/v6/pkg/bindings/pods"
	entities "go.podman.io/podman/v6/pkg/domain/entities/types"
	"go.podman.io/podman/v6/pkg/specgen"
)

// guestRestartPolicy keeps guest pods and containers alive across podman/host
// restarts. "unless-stopped" restarts after a crash or a podman restart but
// respects an explicit stop, which is what the orchestrator's own stop and
// recreate paths perform.
const guestRestartPolicy = "unless-stopped"

// newGuestPodSpec builds the pod spec for one workspace's pod, carrying the
// restart policy so its containers come back after a podman/host restart.
func newGuestPodSpec(name string) *entities.PodSpec {
	return &entities.PodSpec{
		PodSpecGen: specgen.PodSpecGenerator{Name: name, RestartPolicy: guestRestartPolicy},
	}
}

// applyGuestContainerPolicy stamps the guest container policy onto a spec
// generator.
func applyGuestContainerPolicy(generator *specgen.SpecGenerator) {
	generator.RestartPolicy = guestRestartPolicy
	// The root filesystem is read-only, so the container needs writable
	// scratch space. Podman's CLI defaults --read-only-tmpfs to true, but the
	// specgen API does not: without it no tmpfs is mounted and /tmp, /var/tmp
	// and /run stay on the read-only rootfs. It also leaves /dev and /dev/shm
	// writable instead of applying the read-only dev profile.
	generator.ReadOnlyFilesystem = boolPtr(true)
	generator.ReadWriteTmpfs = boolPtr(true)
}

type Client struct {
	ctx                                             context.Context
	socketRoot, hostSocketRoot, projectRoot         string
	guestAgentImage, guestAgentBin, guestAgentMount string
	hostGuestBinary                                 string
	logger                                          *slog.Logger
}

func New(ctx context.Context, socket, socketRoot, guestAgentImage, guestAgentBin, guestAgentMount, hostSocketRoot, projectRoot, hostGuestBinary string, logger *slog.Logger) (*Client, error) {
	connected, err := bindings.NewConnection(ctx, socket)
	if err != nil {
		return nil, err
	}
	return &Client{ctx: connected, socketRoot: socketRoot, hostSocketRoot: hostSocketRoot, projectRoot: projectRoot, guestAgentImage: guestAgentImage, guestAgentBin: guestAgentBin, guestAgentMount: guestAgentMount, hostGuestBinary: hostGuestBinary, logger: logger}, nil
}

func (c *Client) log() *slog.Logger {
	if c.logger != nil {
		return c.logger
	}
	return slog.Default()
}

// connReady guards against a client whose podman connection context is
// missing (e.g. a zero-value Client constructed without New), turning what
// would otherwise be a panic into a regular error.
func (c *Client) connReady() error {
	if c.ctx == nil {
		return errors.New("podman connection is not configured")
	}
	return nil
}

// EnsurePod lazily creates the pod when it does not already exist. Containers
// created afterwards are placed inside it, sharing its network namespace.
func (c *Client) EnsurePod(name string) error {
	exists, err := pods.Exists(c.ctx, name, nil)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	c.log().Info("creating pod", "pod_name", name)
	_, err = pods.CreatePodFromSpec(c.ctx, newGuestPodSpec(name))
	if err != nil {
		c.log().Error("pod creation failed", "pod_name", name, "error", err)
		return fmt.Errorf("create pod: %w", err)
	}
	return nil
}

// RemovePod deletes the pod, tolerating an already-absent pod.
func (c *Client) RemovePod(name string) error {
	exists, err := pods.Exists(c.ctx, name, nil)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	c.log().Info("removing pod", "pod_name", name)
	if _, err := pods.Remove(c.ctx, name, &pods.RemoveOptions{Force: boolPtr(true)}); err != nil {
		c.log().Error("pod removal failed", "pod_name", name, "error", err)
		return fmt.Errorf("remove pod: %w", err)
	}
	return nil
}

func (c *Client) CreateWorkspace(pod, name, image, token string, mounts []specs.Mount, secrets []specgen.Secret, envSecrets map[string]string, env map[string]string, paths []string) error {
	c.log().Info("creating guest container", "pod_name", pod, "container_name", name, "image", image, "mount_count", len(mounts))
	socketDir := filepath.Join(c.socketRoot, name)
	hostSocketDir := filepath.Join(c.hostSocketRoot, name)
	if err := os.MkdirAll(socketDir, 0700); err != nil {
		return err
	}
	if err := guestAgentSourcesConfigured(c.hostGuestBinary, c.guestAgentImage); err != nil {
		return err
	}
	if err := c.EnsurePod(pod); err != nil {
		return err
	}
	init := true
	binaryDest := filepath.Join(c.guestAgentMount, c.guestAgentBin)
	generator := specgen.NewSpecGenerator(image, false)
	generator.Name = name
	generator.Pod = pod
	generator.Command = []string{binaryDest}
	containerMounts := append(append([]specs.Mount(nil), mounts...), spillMount())
	generator.Env = containerEnv(c.socketRoot, name, c.projectRoot, token, env, guestFileMounts(containerMounts), paths)
	generator.EnvSecrets = envSecrets
	generator.Secrets = append(generator.Secrets, secrets...)
	generator.Init = &init
	applyGuestContainerPolicy(generator)
	ociMounts, volumes := classifyMounts(containerMounts)
	for _, volume := range volumes {
		if err := c.ensureVolume(volume.Name); err != nil {
			return err
		}
		generator.Volumes = append(generator.Volumes, volume)
	}
	generator.Mounts = append(ociMounts, guestAgentMounts(hostSocketDir, c.socketRoot, name, c.hostGuestBinary, binaryDest)...)
	if imageVolume := guestAgentImageVolume(c.guestAgentImage, c.guestAgentMount); imageVolume != nil {
		if err := c.ensureImage(imageVolume.Source); err != nil {
			return err
		}
		generator.ImageVolumes = append(generator.ImageVolumes, imageVolume)
	}
	if _, err := containers.CreateWithSpec(c.ctx, generator, nil); err != nil {
		c.log().Error("guest container creation failed", "pod_name", pod, "container_name", name, "error", err)
		return fmt.Errorf("create container: %w", err)
	}
	if err := containers.Start(c.ctx, name, nil); err != nil {
		c.log().Error("guest container start failed", "container_name", name, "error", err)
		// The container was created but never came up. Remove it so its name is
		// not left in use by an untracked container.
		if removeErr := c.Remove(name); removeErr != nil {
			c.log().Warn("failed to remove container after start failure", "container_name", name, "error", removeErr)
		}
		return err
	}
	c.log().Info("guest container started", "pod_name", pod, "container_name", name)
	return nil
}

// classifyMounts separates raw OCI mounts (bind, tmpfs) from named-volume
// mounts. Named volumes cannot be handed to the runtime as OCI mounts (crun
// rejects the "volume" type); podman must mount them through its own volume
// mechanism instead.
func classifyMounts(mounts []specs.Mount) (oci []specs.Mount, volumes []*specgen.NamedVolume) {
	for _, mount := range mounts {
		if mount.Type == "volume" {
			volumes = append(volumes, &specgen.NamedVolume{Name: mount.Source, Dest: mount.Destination, Options: mount.Options})
			continue
		}
		oci = append(oci, mount)
	}
	return oci, volumes
}

// spillRoot is the container-local tmpfs where the guest agent writes bounded
// command-output spill files. It is mounted read-write into every guest
// container and exposed to the guest file API so a caller can read a spill
// after the in-memory tail truncates. The plugin must use the same path.
const spillRoot = "/tmp/dsh-podman"

// spillMount is the container-local tmpfs backing spillRoot. The mode keeps it
// writable by the agent regardless of the container user.
func spillMount() specs.Mount {
	return specs.Mount{Type: "tmpfs", Destination: spillRoot, Options: []string{"rw", "mode=1777"}}
}

// guestFileMounts is the mount list the guest file API is told about: the
// container's mounts plus /tmp, which podman mounts through its read-only
// tmpfs but the API must be told about to read and write there. No caller
// mount can target /tmp (it is a reserved destination), so there is never a
// duplicate.
func guestFileMounts(mounts []specs.Mount) []specs.Mount {
	return append(append([]specs.Mount(nil), mounts...),
		specs.Mount{Type: "tmpfs", Destination: "/tmp", Options: []string{"rw"}})
}

// guestAgentMounts returns the socket bind mount and, when a host guest-agent
// binary is configured, a read-only bind mount of that binary at binaryDest.
func guestAgentMounts(hostSocketDir, socketRoot, name, hostGuestBinary, binaryDest string) []specs.Mount {
	mounts := []specs.Mount{{Type: "bind", Source: hostSocketDir, Destination: filepath.Join(socketRoot, name), Options: []string{"rw"}}}
	if hostGuestBinary != "" {
		mounts = append([]specs.Mount{{Type: "bind", Source: hostGuestBinary, Destination: binaryDest, Options: []string{"ro"}}}, mounts...)
	}
	return mounts
}

// guestAgentImageVolume describes the guest-agent image mount, or nil when no
// guest-agent image is configured. Image volumes are always read-only.
func guestAgentImageVolume(image, mountDir string) *specgen.ImageVolume {
	if image == "" {
		return nil
	}
	return &specgen.ImageVolume{Source: image, Destination: mountDir, ReadWrite: false}
}

// guestAgentSourcesConfigured reports an error when neither a host guest-agent
// binary nor a guest-agent image is configured.
func guestAgentSourcesConfigured(hostGuestBinary, guestAgentImage string) error {
	if hostGuestBinary == "" && guestAgentImage == "" {
		return errors.New("no guest agent source configured: set DSH_PODMAN_GUEST_AGENT_IMAGE or DSH_PODMAN_HOST_GUEST_AGENT_BIN")
	}
	return nil
}

// ensureImage pulls the named image into local storage when it is not already
// present.
func (c *Client) ensureImage(name string) error {
	exists, err := c.ImageExists(name)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return c.ImagePull(name)
}

func (c *Client) Stop(name string) error {
	c.log().Info("stopping guest container", "container_name", name)
	err := containers.Stop(c.ctx, name, nil)
	if err != nil {
		c.log().Error("guest container stop failed", "container_name", name, "error", err)
	} else {
		c.log().Info("guest container stopped", "container_name", name)
	}
	return err
}

func (c *Client) ContainerExists(name string) (bool, error) {
	exists, err := containers.Exists(c.ctx, name, nil)
	if err != nil {
		c.log().Error("guest container lookup failed", "container_name", name, "error", err)
	} else {
		c.log().Info("guest container lookup completed", "container_name", name, "exists", exists)
	}
	return exists, err
}

// ContainerRunning reports whether the named container is running. It is used
// to bring a stopped guest container back before handing its socket to a
// caller.
func (c *Client) ContainerRunning(name string) (bool, error) {
	inspect, err := containers.Inspect(c.ctx, name, nil)
	if err != nil {
		c.log().Error("guest container inspect failed", "container_name", name, "error", err)
		return false, err
	}
	running := inspect.State != nil && inspect.State.Running
	c.log().Info("guest container inspect completed", "container_name", name, "running", running)
	return running, nil
}

func boolPtr(value bool) *bool {
	return &value
}

func (c *Client) Remove(name string) error {
	c.log().Info("removing guest container", "container_name", name)
	_, err := containers.Remove(c.ctx, name, &containers.RemoveOptions{Force: boolPtr(true)})
	if err != nil {
		c.log().Error("guest container removal failed", "container_name", name, "error", err)
	} else {
		c.log().Info("guest container removed", "container_name", name)
	}
	return err
}

// RemoveSocketDir deletes a container's socket directory, tolerating an
// already-absent one. It mirrors the directory CreateWorkspace makes for the
// guest agent's socket.
func (c *Client) RemoveSocketDir(name string) error {
	dir := filepath.Join(c.socketRoot, name)
	if err := os.RemoveAll(dir); err != nil {
		c.log().Error("guest socket dir removal failed", "container_name", name, "dir", dir, "error", err)
		return err
	}
	c.log().Info("guest socket dir removed", "container_name", name, "dir", dir)
	return nil
}

func (c *Client) RecreateWorkspace(pod, name, image, token string, mounts []specs.Mount, secrets []specgen.Secret, envSecrets map[string]string, env map[string]string, paths []string) error {
	c.log().Info("recreating guest container", "pod_name", pod, "container_name", name, "image", image, "mount_count", len(mounts))
	exists, err := c.ContainerExists(name)
	if err != nil {
		return err
	}
	if exists {
		if err := c.Stop(name); err != nil {
			return err
		}
		if err := c.Remove(name); err != nil {
			return err
		}
	}
	return c.CreateWorkspace(pod, name, image, token, mounts, secrets, envSecrets, env, paths)
}

// containerEnv builds the guest container environment: the reserved
// orchestrator agent variables, then every user variable. User keys that
// collide with the reserved DSH_PODMAN namespace are skipped defensively (the
// caller has already validated them).
func containerEnv(socketRoot, name, projectRoot, token string, user map[string]string, mounts []specs.Mount, paths []string) map[string]string {
	env := map[string]string{
		"DSH_PODMAN_GUEST_TOKEN":   token,
		"DSH_PODMAN_GUEST_SOCKET":  filepath.Join(socketRoot, name, "guest.sock"),
		"DSH_PODMAN_PROJECTS_ROOT": projectRoot,
	}
	if encoded := guestMountsEnv(mounts); encoded != "" {
		env["DSH_PODMAN_GUEST_MOUNTS"] = encoded
	}
	if encoded := guestPathsEnv(paths); encoded != "" {
		env["DSH_PODMAN_GUEST_PATHS"] = encoded
	}
	for key, value := range user {
		if strings.HasPrefix(key, "DSH_PODMAN") {
			continue
		}
		env[key] = value
	}
	return env
}

// guestPathsEnv serializes the container's PATH additions for the guest agent,
// which prepends them to every process it starts. Empty means no additions.
func guestPathsEnv(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	encoded, err := json.Marshal(paths)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// guestMountsEnv serializes the container's user mounts for the guest agent.
// Project bind mounts are covered by the projects root and are not listed.
// Secret mounts are deliberately omitted so the file API never reads them.
func guestMountsEnv(mounts []specs.Mount) string {
	entries := make([]map[string]any, 0, len(mounts))
	for _, mount := range mounts {
		switch mount.Type {
		case "tmpfs":
			entries = append(entries, map[string]any{"path": mount.Destination, "read_only": false})
		case "volume":
			entries = append(entries, map[string]any{"path": mount.Destination, "read_only": hasOption(mount.Options, "ro")})
		}
	}
	if len(entries) == 0 {
		return ""
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func hasOption(options []string, want string) bool {
	for _, option := range options {
		if option == want {
			return true
		}
	}
	return false
}
