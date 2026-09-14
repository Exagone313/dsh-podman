// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"log/slog"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/opencontainers/runtime-spec/specs-go"
	"go.podman.io/podman/v6/pkg/specgen"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// podmanAPI is the subset of the podman client the control plane drives. It is
// a consumer-side interface so tests can substitute a fake without a podman
// daemon; *podman.Client satisfies it.
type podmanAPI interface {
	ContainerExists(name string) (bool, error)
	ContainerRunning(name string) (bool, error)
	CreateWorkspace(pod, name, image, token string, mounts []specs.Mount, secrets []specgen.Secret, envSecrets map[string]string, env map[string]string) error
	RecreateWorkspace(pod, name, image, token string, mounts []specs.Mount, secrets []specgen.Secret, envSecrets map[string]string, env map[string]string) error
	Remove(name string) error
	RemovePod(name string) error
	RemoveSocketDir(name string) error
	Stop(name string) error
	ImageExists(name string) (bool, error)
	ImageCreated(name string) string
	ImagePull(name string) error
	ImageRemove(name string) error
	VolumeExists(name string) (bool, error)
	VolumeCreate(name string) error
	VolumeList() ([]string, error)
	VolumeRemove(name string) error
	SecretExists(name string) (bool, error)
	SecretCreate(name, value string) error
	SecretList() ([]string, error)
	SecretRemove(name string) error
}

type Server struct {
	ctl.UnimplementedOrchestratorControlServer
	ProjectsRoot     string
	HostProjectsRoot string
	SocketsRoot      string
	// GuestAgentMount is the container path the guest agent image is mounted
	// at. Mounts must not shadow it: the container's entry point is executed
	// from below it.
	GuestAgentMount string
	Store           *state.Store
	Podman          podmanAPI
	ImageBuilder    *imagebuild.Builder
	BaseImagePrefix string
	VolumePrefix    string
	SecretPrefix    string
	Logger          *slog.Logger
}

func (s *Server) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

func UnaryLogger(logger *slog.Logger) grpc.UnaryServerInterceptor {
	if logger == nil {
		logger = slog.Default()
	}
	return func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		logger.Info("gRPC request", "method", info.FullMethod, "request_type", fmt.Sprintf("%T", request))
		response, err := handler(ctx, request)
		if err != nil {
			logger.Error("gRPC request failed", "method", info.FullMethod, "error", err)
			return response, err
		}
		logger.Info("gRPC request completed", "method", info.FullMethod)
		return response, nil
	}
}

// grpcError maps a plain error to an Internal status error, passing through
// status errors produced by the resolution helpers unchanged.
func grpcError(err error) error {
	if code := status.Code(err); code != codes.Unknown {
		return err
	}
	return status.Error(codes.Internal, err.Error())
}

// cloneMap returns a shallow copy of a string map, or nil when the source is
// empty. A nil source yields nil.
func cloneMap(source map[string]string) map[string]string {
	if len(source) == 0 {
		return nil
	}
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
