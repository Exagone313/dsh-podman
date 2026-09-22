// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"strings"
	"testing"

	"github.com/Exagone313/dsh-podman/internal/version"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// callVersion runs the interceptor for one plugin version header (an empty
// value means the header is absent) against the given orchestrator version.
func callVersion(t *testing.T, plugin, orchestrator string) error {
	t.Helper()
	previous := version.Version
	version.Version = orchestrator
	t.Cleanup(func() { version.Version = previous })

	ctx := context.Background()
	if plugin != "" {
		ctx = metadata.NewIncomingContext(ctx, metadata.Pairs(PluginVersionHeader, plugin))
	}
	_, err := UnaryVersion(nil)(ctx, nil, &grpc.UnaryServerInfo{FullMethod: "/dshctl.v1.OrchestratorControl/ListProjects"},
		func(context.Context, any) (any, error) { return "ok", nil })
	return err
}

func TestUnaryVersionAcceptsCompatiblePlugins(t *testing.T) {
	for _, tc := range []struct {
		name         string
		plugin       string
		orchestrator string
	}{
		{"identical", "1.2.3", "1.2.3"},
		{"minor differs", "1.3.0", "1.2.3"},
		{"patch differs", "1.2.4", "1.2.3"},
		{"describe suffix", "1.2.3-4-gabc123", "1.2.3"},
		{"orchestrator has no version", "1.2.3", "dev"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := callVersion(t, tc.plugin, tc.orchestrator); err != nil {
				t.Fatalf("expected the call to pass, got %v", err)
			}
		})
	}
}

func TestUnaryVersionRejectsIncompatiblePlugins(t *testing.T) {
	for _, tc := range []struct {
		name         string
		plugin       string
		orchestrator string
		want         string
	}{
		{"missing header", "", "1.2.3", "did not report its version"},
		{"unusable plugin version", "dev", "1.2.3", "unusable version"},
		{"older plugin", "1.9.0", "2.0.0", "the plugin is older, update the dsh image"},
		{"older orchestrator", "2.0.0", "1.9.0", "the orchestrator is older, update the orchestrator image"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := callVersion(t, tc.plugin, tc.orchestrator)
			if status.Code(err) != codes.FailedPrecondition {
				t.Fatalf("expected FailedPrecondition, got %v", err)
			}
			if got := status.Convert(err).Message(); !strings.Contains(got, tc.want) {
				t.Fatalf("message %q does not contain %q", got, tc.want)
			}
		})
	}
}

func TestUnaryVersionExemptsGetVersion(t *testing.T) {
	previous := version.Version
	version.Version = "2.0.0"
	t.Cleanup(func() { version.Version = previous })

	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs(PluginVersionHeader, "1.0.0"))
	_, err := UnaryVersion(nil)(ctx, nil, &grpc.UnaryServerInfo{FullMethod: GetVersionFullMethod},
		func(context.Context, any) (any, error) { return "ok", nil })
	if err != nil {
		t.Fatalf("GetVersion must be exempt from the version check, got %v", err)
	}
}

func TestGetVersionReportsTheBuildVersion(t *testing.T) {
	previousVersion, previousCommit := version.Version, version.Commit
	version.Version, version.Commit = "1.2.3", "abc123"
	t.Cleanup(func() {
		version.Version, version.Commit = previousVersion, previousCommit
	})

	response, err := (&Server{}).GetVersion(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.GetVersion() != "1.2.3" || response.GetCommit() != "abc123" {
		t.Fatalf("unexpected response %#v", response)
	}
}
