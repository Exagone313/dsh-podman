// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/containers/podman/v5/pkg/bindings"
	"github.com/containers/podman/v5/pkg/bindings/containers"
	"github.com/containers/podman/v5/pkg/bindings/images"
	"github.com/containers/podman/v5/pkg/bindings/pods"
	"github.com/containers/podman/v5/pkg/bindings/secrets"
	"github.com/containers/podman/v5/pkg/bindings/volumes"
	entities "github.com/containers/podman/v5/pkg/domain/entities/types"
	"github.com/containers/podman/v5/pkg/specgen"
	"github.com/opencontainers/runtime-spec/specs-go"
)

type Client struct {
	ctx                                                                   context.Context
	socketRoot, hostSocketRoot, projectRoot, guestBinary, hostGuestBinary string
	logger                                                                *slog.Logger
}

func New(ctx context.Context, socket, socketRoot, guestBinary, hostSocketRoot, projectRoot, hostGuestBinary string, logger *slog.Logger) (*Client, error) {
	connected, err := bindings.NewConnection(ctx, socket)
	if err != nil {
		return nil, err
	}
	return &Client{ctx: connected, socketRoot: socketRoot, hostSocketRoot: hostSocketRoot, projectRoot: projectRoot, guestBinary: guestBinary, hostGuestBinary: hostGuestBinary, logger: logger}, nil
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
	_, err = pods.CreatePodFromSpec(c.ctx, &entities.PodSpec{PodSpecGen: specgen.PodSpecGenerator{Name: name}})
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

func (c *Client) CreateWorkspace(pod, name, image, token string, mounts []specs.Mount, secrets []specgen.Secret, envSecrets map[string]string, env map[string]string) error {
	c.log().Info("creating guest container", "pod_name", pod, "container_name", name, "image", image, "mount_count", len(mounts))
	socketDir := filepath.Join(c.socketRoot, name)
	hostSocketDir := filepath.Join(c.hostSocketRoot, name)
	if err := os.MkdirAll(socketDir, 0700); err != nil {
		return err
	}
	if err := c.EnsurePod(pod); err != nil {
		return err
	}
	init := true
	generator := specgen.NewSpecGenerator(image, false)
	generator.Name = name
	generator.Pod = pod
	generator.Command = []string{c.guestBinary}
	generator.Env = containerEnv(c.socketRoot, name, c.projectRoot, token, env)
	generator.EnvSecrets = envSecrets
	generator.Secrets = append(generator.Secrets, secrets...)
	generator.Init = &init
	generator.ReadOnlyFilesystem = boolPtr(true)
	ociMounts, volumes := classifyMounts(mounts)
	for _, volume := range volumes {
		if err := c.ensureVolume(volume.Name); err != nil {
			return err
		}
		generator.Volumes = append(generator.Volumes, volume)
	}
	generator.Mounts = append(ociMounts, guestAgentMounts(hostSocketDir, c.socketRoot, name, c.hostGuestBinary, c.guestBinary)...)
	if _, err := containers.CreateWithSpec(c.ctx, generator, nil); err != nil {
		c.log().Error("guest container creation failed", "pod_name", pod, "container_name", name, "error", err)
		return fmt.Errorf("create container: %w", err)
	}
	if err := containers.Start(c.ctx, name, nil); err != nil {
		c.log().Error("guest container start failed", "pod_name", pod, "container_name", name, "error", err)
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

func guestAgentMounts(hostSocketDir, socketRoot, name, hostGuestBinary, guestBinary string) []specs.Mount {
	mounts := []specs.Mount{{Type: "bind", Source: hostSocketDir, Destination: filepath.Join(socketRoot, name), Options: []string{"rw"}}}
	if hostGuestBinary != "" {
		mounts = append([]specs.Mount{{Type: "bind", Source: hostGuestBinary, Destination: guestBinary, Options: []string{"ro"}}}, mounts...)
	}
	return mounts
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

func boolPtr(value bool) *bool {
	return &value
}

// ImageExists reports whether the named image is present in local storage.
func (c *Client) ImageExists(name string) (bool, error) {
	if err := c.connReady(); err != nil {
		return false, err
	}
	exists, err := images.Exists(c.ctx, name, nil)
	if err != nil {
		c.log().Error("workspace image lookup failed", "image", name, "error", err)
	} else {
		c.log().Info("workspace image lookup completed", "image", name, "exists", exists)
	}
	return exists, err
}

// ImagePull pulls the named image into local storage. The name is the only
// detail logged; pulled layers are never echoed.
func (c *Client) ImagePull(name string) error {
	if err := c.connReady(); err != nil {
		return err
	}
	c.log().Info("pulling image", "image", name)
	if _, err := images.Pull(c.ctx, name, nil); err != nil {
		c.log().Error("image pull failed", "image", name, "error", err)
		return err
	}
	c.log().Info("image pulled", "image", name)
	return nil
}

// ImageCreated returns the image's creation time as an RFC3339 string, or ""
// when the image does not exist or its creation time cannot be read.
func (c *Client) ImageCreated(name string) string {
	if err := c.connReady(); err != nil {
		return ""
	}
	report, err := images.GetImage(c.ctx, name, nil)
	if err != nil {
		return ""
	}
	return report.Created.UTC().Format(time.RFC3339)
}

// ImageRemove deletes the named image from local storage, tolerating an
// already-absent image via the force option. Any non-nil errors reported by
// images.Remove are joined into a single error.
func (c *Client) ImageRemove(name string) error {
	if err := c.connReady(); err != nil {
		return err
	}
	c.log().Info("removing image", "image", name)
	_, errs := images.Remove(c.ctx, []string{name}, &images.RemoveOptions{Force: boolPtr(true)})
	var joined error
	for _, err := range errs {
		if err != nil {
			joined = errors.Join(joined, err)
		}
	}
	if joined != nil {
		c.log().Error("image removal failed", "image", name, "error", joined)
		return joined
	}
	c.log().Info("image removed", "image", name)
	return nil
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

func (c *Client) RecreateWorkspace(pod, name, image, token string, mounts []specs.Mount, secrets []specgen.Secret, envSecrets map[string]string, env map[string]string) error {
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
	return c.CreateWorkspace(pod, name, image, token, mounts, secrets, envSecrets, env)
}

// containerEnv builds the guest container environment: the reserved
// orchestrator agent variables, then every user variable. User keys that
// collide with the reserved DSH_PODMAN namespace are skipped defensively (the
// caller has already validated them).
func containerEnv(socketRoot, name, projectRoot, token string, user map[string]string) map[string]string {
	env := map[string]string{
		"DSH_PODMAN_GUEST_TOKEN":   token,
		"DSH_PODMAN_GUEST_SOCKET":  filepath.Join(socketRoot, name, "guest.sock"),
		"DSH_PODMAN_PROJECTS_ROOT": projectRoot,
	}
	for key, value := range user {
		if strings.HasPrefix(key, "DSH_PODMAN") {
			continue
		}
		env[key] = value
	}
	return env
}

func (c *Client) VolumeExists(name string) (bool, error) {
	return volumes.Exists(c.ctx, name, nil)
}

// ensureVolume auto-creates a named volume when it does not already exist.
func (c *Client) ensureVolume(name string) error {
	exists, err := c.VolumeExists(name)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return c.VolumeCreate(name)
}

func (c *Client) VolumeCreate(name string) error {
	_, err := volumes.Create(c.ctx, entities.VolumeCreateOptions{Name: name}, nil)
	if err != nil {
		c.log().Error("volume creation failed", "volume_name", name, "error", err)
		return fmt.Errorf("create volume: %w", err)
	}
	c.log().Info("volume created", "volume_name", name)
	return nil
}

func (c *Client) VolumeList() ([]string, error) {
	reports, err := volumes.List(c.ctx, nil)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(reports))
	for _, report := range reports {
		names = append(names, report.Name)
	}
	return names, nil
}

func (c *Client) VolumeRemove(name string) error {
	if err := volumes.Remove(c.ctx, name, &volumes.RemoveOptions{Force: boolPtr(true)}); err != nil {
		c.log().Error("volume removal failed", "volume_name", name, "error", err)
		return fmt.Errorf("remove volume: %w", err)
	}
	c.log().Info("volume removed", "volume_name", name)
	return nil
}

func (c *Client) SecretExists(name string) (bool, error) {
	return secrets.Exists(c.ctx, name)
}

// SecretCreate stores a secret value under the given name. The value is never
// logged; only the name is.
func (c *Client) SecretCreate(name, value string) error {
	if _, err := secrets.Create(c.ctx, strings.NewReader(value), &secrets.CreateOptions{Name: &name}); err != nil {
		c.log().Error("secret creation failed", "secret_name", name, "error", err)
		return fmt.Errorf("create secret: %w", err)
	}
	c.log().Info("secret created", "secret_name", name)
	return nil
}

// SecretList returns the full podman names of every secret.
func (c *Client) SecretList() ([]string, error) {
	reports, err := secrets.List(c.ctx, nil)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(reports))
	for _, report := range reports {
		names = append(names, report.Spec.Name)
	}
	return names, nil
}

func (c *Client) SecretRemove(name string) error {
	if err := secrets.Remove(c.ctx, name); err != nil {
		c.log().Error("secret removal failed", "secret_name", name, "error", err)
		return fmt.Errorf("remove secret: %w", err)
	}
	c.log().Info("secret removed", "secret_name", name)
	return nil
}
