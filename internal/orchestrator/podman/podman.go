package podman

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/containers/podman/v5/pkg/bindings"
	"github.com/containers/podman/v5/pkg/bindings/containers"
	"github.com/containers/podman/v5/pkg/specgen"
	"github.com/opencontainers/runtime-spec/specs-go"
)

type Client struct {
	ctx                     context.Context
	socketRoot, agentBinary string
}

func New(ctx context.Context, socket, socketRoot, agentBinary string) (*Client, error) {
	connected, err := bindings.NewConnection(ctx, socket)
	if err != nil {
		return nil, err
	}
	return &Client{ctx: connected, socketRoot: socketRoot, agentBinary: agentBinary}, nil
}
func (c *Client) CreateWorkspace(name, image, token string, mounts []specs.Mount) error {
	socketDir := filepath.Join(c.socketRoot, name)
	if err := os.MkdirAll(socketDir, 0700); err != nil {
		return err
	}
	init := true
	generator := specgen.NewSpecGenerator(image, false)
	generator.Name = name
	generator.Command = []string{c.agentBinary}
	generator.Env = map[string]string{"DSH_AGENT_TOKEN": token, "DSH_AGENT_SOCKET": "/run/dsh-sockets/agent.sock"}
	generator.Init = &init
	generator.Mounts = append(mounts, specs.Mount{Type: "bind", Source: c.agentBinary, Destination: c.agentBinary, Options: []string{"ro"}}, specs.Mount{Type: "bind", Source: socketDir, Destination: "/run/dsh-sockets", Options: []string{"rw"}})
	if _, err := containers.CreateWithSpec(c.ctx, generator, nil); err != nil {
		return fmt.Errorf("create container: %w", err)
	}
	return containers.Start(c.ctx, name, nil)
}
func (c *Client) Stop(name string) error { return containers.Stop(c.ctx, name, nil) }
func (c *Client) Remove(name string) error {
	_, err := containers.Remove(c.ctx, name, &containers.RemoveOptions{})
	return err
}
