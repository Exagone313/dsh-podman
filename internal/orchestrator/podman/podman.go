package podman

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/containers/podman/v5/pkg/bindings"
	"github.com/containers/podman/v5/pkg/bindings/containers"
	"github.com/containers/podman/v5/pkg/bindings/images"
	"github.com/containers/podman/v5/pkg/specgen"
	"github.com/opencontainers/runtime-spec/specs-go"
)

type Client struct {
	ctx                                                                   context.Context
	socketRoot, hostSocketRoot, projectRoot, agentBinary, hostAgentBinary string
}

const agentDestination = "/usr/local/bin/dsh-workspace-agent"

func New(ctx context.Context, socket, socketRoot, agentBinary, hostSocketRoot, projectRoot, hostAgentBinary string) (*Client, error) {
	connected, err := bindings.NewConnection(ctx, socket)
	if err != nil {
		return nil, err
	}
	return &Client{ctx: connected, socketRoot: socketRoot, hostSocketRoot: hostSocketRoot, projectRoot: projectRoot, agentBinary: binaryPath(agentBinary), hostAgentBinary: binaryPath(hostAgentBinary)}, nil
}

func binaryPath(path string) string {
	if filepath.Base(path) == "dsh-workspace-agent" {
		return path
	}
	return filepath.Join(path, "dsh-workspace-agent")
}
func (c *Client) CreateWorkspace(name, image, token string, mounts []specs.Mount) error {
	socketDir := filepath.Join(c.socketRoot, name)
	hostSocketDir := filepath.Join(c.hostSocketRoot, name)
	if err := os.MkdirAll(socketDir, 0700); err != nil {
		return err
	}
	init := true
	generator := specgen.NewSpecGenerator(image, false)
	generator.Name = name
	generator.Command = []string{agentDestination}
	generator.Env = map[string]string{"DSH_AGENT_TOKEN": token, "DSH_AGENT_SOCKET": filepath.Join(c.socketRoot, name, "agent.sock"), "DSH_WORKSPACE_ROOT": c.projectRoot}
	generator.Init = &init
	generator.Mounts = append(mounts, specs.Mount{Type: "bind", Source: c.hostAgentBinary, Destination: agentDestination, Options: []string{"ro"}}, specs.Mount{Type: "bind", Source: hostSocketDir, Destination: filepath.Join(c.socketRoot, name), Options: []string{"rw"}})
	if _, err := containers.CreateWithSpec(c.ctx, generator, nil); err != nil {
		return fmt.Errorf("create container: %w", err)
	}
	return containers.Start(c.ctx, name, nil)
}
func (c *Client) Stop(name string) error                { return containers.Stop(c.ctx, name, nil) }
func (c *Client) ImageExists(name string) (bool, error) { return images.Exists(c.ctx, name, nil) }
func (c *Client) Remove(name string) error {
	_, err := containers.Remove(c.ctx, name, &containers.RemoveOptions{})
	return err
}

func (c *Client) RecreateWorkspace(name, image, token string, mounts []specs.Mount) error {
	if err := c.Stop(name); err != nil {
		return err
	}
	if err := c.Remove(name); err != nil {
		return err
	}
	return c.CreateWorkspace(name, image, token, mounts)
}
