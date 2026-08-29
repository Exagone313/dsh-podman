// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"gitlab.com/Exagone313/dsh-podman/internal/guestagent/daemon"
	"gitlab.com/Exagone313/dsh-podman/internal/guestagent/exec"
	workspacefs "gitlab.com/Exagone313/dsh-podman/internal/guestagent/fs"
	guest "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Server struct {
	guest.UnimplementedWorkspaceGuestAgentServer
	Processes *exec.Manager
	Daemons   *daemon.Manager
	FS        *workspacefs.WorkspaceFS
}

func New() *Server { return &Server{Processes: exec.NewManager(), Daemons: daemon.NewManager()} }

func (s *Server) WithFS(filesystem *workspacefs.WorkspaceFS) *Server { s.FS = filesystem; return s }

func (s *Server) Exec(stream guest.WorkspaceGuestAgent_ExecServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	start := first.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "first exec message must be start")
	}
	argv := first.GetStart().GetArgv()
	argv0 := ""
	if len(argv) > 0 {
		argv0 = argv[0]
	}
	slog.Info("guest agent Exec started", "argv0", argv0, "argc", len(argv))
	process, err := s.Processes.Start(stream.Context(), start.GetArgv(), start.GetCwd(), start.GetEnv())
	if err != nil {
		return status.Error(codes.InvalidArgument, err.Error())
	}
	stdout, err := process.Command.StdoutPipe()
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	stderr, err := process.Command.StderrPipe()
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	stdin, err := process.Command.StdinPipe()
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	if err := process.Command.Start(); err != nil {
		s.Processes.Remove(process.ID)
		return status.Error(codes.InvalidArgument, err.Error())
	}
	var sendMu sync.Mutex
	send := func(output *guest.ExecOutput) error {
		output.ProcessId = process.ID
		sendMu.Lock()
		defer sendMu.Unlock()
		return stream.Send(output)
	}
	errCh := make(chan error, 2)
	copyOutput := func(reader io.Reader, stderr bool) {
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := reader.Read(buffer)
			if n > 0 {
				data := append([]byte(nil), buffer[:n]...)
				output := &guest.ExecOutput{}
				if stderr {
					output.Payload = &guest.ExecOutput_StderrChunk{StderrChunk: data}
				} else {
					output.Payload = &guest.ExecOutput_StdoutChunk{StdoutChunk: data}
				}
				if sendErr := send(output); sendErr != nil {
					errCh <- sendErr
					return
				}
			}
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) {
					errCh <- readErr
				}
				return
			}
		}
	}
	go copyOutput(stdout, false)
	go copyOutput(stderr, true)
	go func() {
		for {
			input, recvErr := stream.Recv()
			if errors.Is(recvErr, io.EOF) {
				_ = stdin.Close()
				return
			}
			if recvErr != nil {
				_ = stdin.Close()
				return
			}
			if chunk := input.GetStdinChunk(); len(chunk) > 0 {
				if _, writeErr := stdin.Write(chunk); writeErr != nil {
					_ = stdin.Close()
					return
				}
			}
		}
	}()
	waitErr := process.Command.Wait()
	s.Processes.Remove(process.ID)
	exit := int32(0)
	signaled := false
	signalName := ""
	if waitErr != nil {
		exit = 1
		var exitErr *osexec.ExitError
		if errors.As(waitErr, &exitErr) {
			exit = int32(exitErr.ExitCode())
			if waitStatus, ok := exitErr.Sys().(interface {
				Signaled() bool
				Signal() os.Signal
			}); ok && waitStatus.Signaled() {
				signaled = true
				signalName = waitStatus.Signal().String()
			}
		}
	}
	if err := send(&guest.ExecOutput{Payload: &guest.ExecOutput_Exit{Exit: &guest.ExecExit{ExitCode: exit, Signaled: signaled, Signal: signalName}}}); err != nil {
		return err
	}
	slog.Info("guest agent Exec completed", "exit_code", exit, "signaled", signaled)
	return nil
}

func (s *Server) Signal(_ context.Context, request *guest.SignalRequest) (*guest.SignalResponse, error) {
	for _, process := range s.Processes.List() {
		if process.ID == request.GetProcessId() {
			if err := process.Command.Process.Signal(signalForName(request.GetSignal())); err != nil {
				return nil, status.Error(codes.Internal, err.Error())
			}
			return &guest.SignalResponse{}, nil
		}
	}
	return nil, status.Error(codes.NotFound, "process not found")
}

func signalForName(name string) os.Signal {
	if name == "SIGKILL" {
		return os.Kill
	}
	if name == "SIGTERM" {
		return os.Interrupt
	}
	return os.Interrupt
}

func (s *Server) ListProcesses(context.Context, *guest.ListProcessesRequest) (*guest.ListProcessesResponse, error) {
	result := &guest.ListProcessesResponse{}
	for _, process := range s.Processes.List() {
		running := process.Command.ProcessState == nil
		result.Processes = append(result.Processes, &guest.ProcessInfo{ProcessId: process.ID, Argv: process.Argv, Running: running})
	}
	return result, nil
}

func daemonInfoProto(d daemon.Daemon) *guest.DaemonInfo {
	return &guest.DaemonInfo{
		Name:      d.Name,
		Argv:      d.Argv,
		Running:   d.Running,
		ExitCode:  d.ExitCode,
		StartedAt: d.StartedAt,
		StoppedAt: d.StoppedAt,
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
	name, err := s.Daemons.Start(request.GetName(), request.GetArgv(), request.GetCwd(), request.GetEnv())
	if err != nil {
		if errors.Is(err, daemon.ErrAlreadyRunning) {
			return nil, status.Error(codes.AlreadyExists, err.Error())
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
	if err := s.Daemons.Stop(request.GetName(), signalForName(request.GetSignal())); err != nil {
		if errors.Is(err, daemon.ErrUnknown) {
			return nil, status.Error(codes.NotFound, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.StopDaemonResponse{}, nil
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

func (s *Server) ValidateProcessID(id string) bool {
	_, err := strconv.ParseUint(id, 10, 64)
	return err == nil
}

func (s *Server) resolve(path string, write bool) (string, error) {
	if s.FS == nil {
		return "", errors.New("filesystem is not configured")
	}
	resolved, _, err := s.FS.Resolve(path, write)
	return resolved, err
}
func (s *Server) ReadFile(request *guest.ReadFileRequest, stream guest.WorkspaceGuestAgent_ReadFileServer) error {
	slog.Info("guest agent ReadFile requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), false)
	if err != nil {
		return status.Error(codes.PermissionDenied, err.Error())
	}
	file, err := os.Open(path)
	if err != nil {
		return status.Error(codes.NotFound, err.Error())
	}
	defer file.Close()
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := file.Read(buffer)
		if n > 0 {
			if err := stream.Send(&guest.ReadFileChunk{Data: append([]byte(nil), buffer[:n]...)}); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return status.Error(codes.Internal, readErr.Error())
		}
	}
}
func (s *Server) WriteFile(stream guest.WorkspaceGuestAgent_WriteFileServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	start := first.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "first write message must be start")
	}
	slog.Info("guest agent WriteFile requested", "path", start.GetPath())
	path, err := s.resolve(start.GetPath(), true)
	if err != nil {
		return status.Error(codes.PermissionDenied, err.Error())
	}
	flags := os.O_WRONLY
	if start.GetCreate() {
		flags |= os.O_CREATE
	}
	if start.GetTruncate() {
		flags |= os.O_TRUNC
	}
	if !start.GetCreate() {
		if _, statErr := os.Stat(path); statErr != nil {
			return status.Error(codes.NotFound, statErr.Error())
		}
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".dsh-write-*")
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0600); err != nil {
		temporary.Close()
		return status.Error(codes.Internal, err.Error())
	}
	file := temporary
	var written int64
	for {
		chunk, recvErr := stream.Recv()
		if errors.Is(recvErr, io.EOF) {
			if err := file.Close(); err != nil {
				return status.Error(codes.Internal, err.Error())
			}
			if err := os.Rename(temporaryName, path); err != nil {
				return status.Error(codes.Internal, err.Error())
			}
			return stream.SendAndClose(&guest.WriteFileResponse{BytesWritten: written})
		}
		if recvErr != nil {
			return recvErr
		}
		if data := chunk.GetDataChunk(); len(data) > 0 {
			n, writeErr := file.Write(data)
			written += int64(n)
			if writeErr != nil {
				return status.Error(codes.Internal, writeErr.Error())
			}
		}
	}
}
func (s *Server) Stat(_ context.Context, request *guest.StatRequest) (*guest.StatResponse, error) {
	slog.Info("guest agent Stat requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), false)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &guest.StatResponse{}, nil
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.StatResponse{Exists: true, IsDir: info.IsDir(), Size: info.Size(), Mode: info.Mode().String(), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano)}, nil
}
func (s *Server) ReadDir(_ context.Context, request *guest.ReadDirRequest) (*guest.ReadDirResponse, error) {
	slog.Info("guest agent ReadDir requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), false)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &guest.ReadDirResponse{}
	for _, entry := range entries {
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil, status.Error(codes.Internal, infoErr.Error())
		}
		result.Entries = append(result.Entries, &guest.DirEntry{Name: entry.Name(), IsDir: entry.IsDir(), Size: info.Size()})
	}
	return result, nil
}
func (s *Server) Mkdir(_ context.Context, request *guest.MkdirRequest) (*guest.MkdirResponse, error) {
	slog.Info("guest agent Mkdir requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), true)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	if request.GetParents() {
		err = os.MkdirAll(path, 0755)
	} else {
		err = os.Mkdir(path, 0755)
	}
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.MkdirResponse{}, nil
}
func (s *Server) Delete(_ context.Context, request *guest.DeleteRequest) (*guest.DeleteResponse, error) {
	slog.Info("guest agent Delete requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), true)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	if request.GetRecursive() {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.DeleteResponse{}, nil
}
