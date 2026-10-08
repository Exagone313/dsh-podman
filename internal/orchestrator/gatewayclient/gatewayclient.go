// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package gatewayclient is the orchestrator's client for the optional gateway.
// It sends the orchestrator version header the gateway checks, and, when a
// token is configured, the same optional bearer credential the control plane
// uses.
package gatewayclient

import (
	"context"
	"time"

	"github.com/Exagone313/dsh-podman/internal/gateway"
	gw "github.com/Exagone313/dsh-podman/internal/genproto/dshgateway/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

// leasePingInterval is how often the orchestrator pings its lease. The pings
// are the application-level liveness check: a send on a dead transport fails,
// which ends the session so the loop can reconnect and re-establish the
// bindings.
const leasePingInterval = 15 * time.Second

// Client dials a gateway over its Unix socket.
type Client struct {
	// Socket is the gateway's socket inside the shared socket root.
	Socket string
	// Token, when set, is sent as a bearer credential.
	Token string
	// Version is the orchestrator version sent on every call.
	Version string
}

func (c *Client) dial() (*grpc.ClientConn, gw.GatewayClient, error) {
	conn, err := grpc.NewClient("unix://"+c.Socket, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, nil, err
	}
	return conn, gw.NewGatewayClient(conn), nil
}

func (c *Client) outgoing(ctx context.Context) context.Context {
	if c.Token != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "bearer "+c.Token)
	}
	if c.Version != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, gateway.OrchestratorVersionHeader, c.Version)
	}
	return ctx
}

// GetVersion reads the gateway's version, commit and per-process instance id.
func (c *Client) GetVersion(ctx context.Context) (*gw.GetVersionResponse, error) {
	conn, client, err := c.dial()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	return client.GetVersion(c.outgoing(ctx), &gw.GetVersionRequest{})
}

// Bind exposes a published socket on the host and returns the address and port
// the gateway chose.
func (c *Client) Bind(ctx context.Context, podmanName, socketName string, protocol gw.Protocol, suggestedHostPort uint32) (*gw.BindResponse, error) {
	conn, client, err := c.dial()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	return client.Bind(c.outgoing(ctx), &gw.BindRequest{
		PodmanName:        podmanName,
		SocketName:        socketName,
		Protocol:          protocol,
		SuggestedHostPort: suggestedHostPort,
	})
}

// Unbind releases one binding. Releasing a binding that is already gone is not
// an error, so cleanup paths can call it blindly.
func (c *Client) Unbind(ctx context.Context, podmanName, socketName string, protocol gw.Protocol) error {
	conn, client, err := c.dial()
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = client.Unbind(c.outgoing(ctx), &gw.UnbindRequest{PodmanName: podmanName, SocketName: socketName, Protocol: protocol})
	return err
}

// Lease holds a liveness stream open until ctx is cancelled or the gateway goes
// away. onReady runs once the gateway has registered the lease, which is when
// it will accept Bind calls, and its error ends the session.
func (c *Client) Lease(ctx context.Context, onReady func(context.Context) error) error {
	conn, client, err := c.dial()
	if err != nil {
		return err
	}
	defer conn.Close()
	stream, err := client.Lease(c.outgoing(ctx))
	if err != nil {
		return err
	}
	// One ping and its acknowledgement confirm that the gateway has counted
	// this lease, so a Bind that follows cannot race it.
	if err := stream.Send(&gw.LeaseRequest{}); err != nil {
		return err
	}
	if _, err := stream.Recv(); err != nil {
		return err
	}
	if onReady != nil {
		if err := onReady(ctx); err != nil {
			return err
		}
	}
	received := make(chan error, 1)
	go func() {
		for {
			if _, err := stream.Recv(); err != nil {
				received <- err
				return
			}
		}
	}()
	ticker := time.NewTicker(leasePingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-received:
			return err
		case <-ticker.C:
			if err := stream.Send(&gw.LeaseRequest{}); err != nil {
				return err
			}
		}
	}
}
