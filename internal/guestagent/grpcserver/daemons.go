// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"log/slog"
	"syscall"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/guestagent/daemon"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func daemonInfoProto(d daemon.Daemon) *guest.DaemonInfo {
	return &guest.DaemonInfo{
		Name:      d.Name,
		Argv:      d.Argv,
		Running:   d.Running,
		ExitCode:  d.ExitCode,
		StartedAt: d.StartedAt,
		StoppedAt: d.StoppedAt,
		Uid:       d.Uid,
		Gid:       d.Gid,
		Groups:    append([]uint32(nil), d.Groups...),
	}
}

func (s *Server) findDaemon(name string) *guest.DaemonInfo {
	for _, d := range s.Daemons.List() {
		if d.Name == name {
			return daemonInfoProto(d)
		}
	}
	return nil
}

func (s *Server) StartDaemon(_ context.Context, request *guest.StartDaemonRequest) (*guest.DaemonInfo, error) {
	slog.Info("guest agent StartDaemon requested", "name", request.GetName(), "argc", len(request.GetArgv()))
	if len(request.GetArgv()) == 0 {
		return nil, status.Error(codes.InvalidArgument, "argv must contain a command")
	}
	if request.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "daemon name is required")
	}
	// Replace an existing daemon with the same name: stop it first when it is
	// still running so the new process can take over. A stopped daemon is
	// replaced by Start directly.
	if existing := s.findDaemon(request.GetName()); existing != nil && existing.Running {
		if err := s.Daemons.Stop(request.GetName(), syscall.SIGTERM); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	uid, err := optionalID(request.GetUid(), "uid")
	if err != nil {
		return nil, err
	}
	gid, err := optionalID(request.GetGid(), "gid")
	if err != nil {
		return nil, err
	}
	name, err := s.Daemons.Start(request.GetName(), request.GetArgv(), request.GetCwd(), request.GetEnv(), daemon.StartOptions{Uid: uid, Gid: gid, Groups: request.GetGroups(), IsolatedEnv: request.GetInheritEnv() != nil && !request.GetInheritEnv().GetValue()})
	if err != nil {
		if errors.Is(err, daemon.ErrAlreadyRunning) {
			return nil, status.Error(codes.AlreadyExists, err.Error())
		}
		if errors.Is(err, daemon.ErrInvalidName) {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		if errors.Is(err, daemon.ErrTooMany) {
			return nil, status.Error(codes.ResourceExhausted, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	if info := s.findDaemon(name); info != nil {
		return info, nil
	}
	return nil, status.Error(codes.Internal, "daemon registered but not found")
}

func (s *Server) ListDaemons(_ context.Context, _ *guest.ListDaemonsRequest) (*guest.ListDaemonsResponse, error) {
	slog.Info("guest agent ListDaemons requested")
	result := &guest.ListDaemonsResponse{}
	for _, d := range s.Daemons.List() {
		result.Daemons = append(result.Daemons, daemonInfoProto(d))
	}
	return result, nil
}

func (s *Server) StopDaemon(_ context.Context, request *guest.StopDaemonRequest) (*guest.StopDaemonResponse, error) {
	slog.Info("guest agent StopDaemon requested", "name", request.GetName())
	signal, err := signalForName(request.GetSignal())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if err := s.Daemons.Stop(request.GetName(), signal); err != nil {
		if errors.Is(err, daemon.ErrUnknown) {
			return nil, status.Error(codes.NotFound, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.StopDaemonResponse{}, nil
}

func (s *Server) StopAllDaemons(_ context.Context, _ *guest.StopAllDaemonsRequest) (*guest.StopAllDaemonsResponse, error) {
	slog.Info("guest agent StopAllDaemons requested")
	// The orchestrator uses this call as the container's graceful shutdown
	// hook, so terminal sessions must be torn down alongside the daemons.
	s.Terminals.Close()
	names := s.Daemons.StopAll(syscall.SIGTERM)
	return &guest.StopAllDaemonsResponse{Daemons: names}, nil
}

func (s *Server) RestartDaemon(_ context.Context, request *guest.RestartDaemonRequest) (*guest.DaemonInfo, error) {
	slog.Info("guest agent RestartDaemon requested", "name", request.GetName())
	if err := s.Daemons.Restart(request.GetName()); err != nil {
		if errors.Is(err, daemon.ErrUnknown) {
			return nil, status.Error(codes.NotFound, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	if info := s.findDaemon(request.GetName()); info != nil {
		return info, nil
	}
	return nil, status.Error(codes.Internal, "daemon not found after restart")
}

func (s *Server) DaemonLogs(_ context.Context, request *guest.DaemonLogsRequest) (*guest.DaemonLogsResponse, error) {
	slog.Info("guest agent DaemonLogs requested", "name", request.GetName())
	stdout, stderr, err := s.Daemons.Logs(request.GetName(), int(request.GetTailBytes()))
	if err != nil {
		if errors.Is(err, daemon.ErrUnknown) {
			return nil, status.Error(codes.NotFound, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.DaemonLogsResponse{Stdout: stdout, Stderr: stderr}, nil
}
