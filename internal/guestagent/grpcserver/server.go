// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/guestagent/daemon"
	"github.com/Exagone313/dsh-podman/internal/guestagent/exec"
	workspacefs "github.com/Exagone313/dsh-podman/internal/guestagent/fs"
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
	// The process is registered before it is started, so every path that
	// gives up before Command.Start must drop it again. A leaked entry keeps
	// a process with no os.Process in the map for the agent's lifetime, where
	// any later Signal for that id would find it.
	started := false
	defer func() {
		if !started {
			s.Processes.Remove(process.ID)
		}
	}()
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
		return status.Error(codes.InvalidArgument, err.Error())
	}
	started = true
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
		if process.ID != request.GetProcessId() {
			continue
		}
		// Command.Process is nil until Command.Start succeeds, and Exec
		// registers the process before starting it.
		if process.Command == nil || process.Command.Process == nil {
			return nil, status.Error(codes.FailedPrecondition, "process is not running")
		}
		signal, err := signalForName(request.GetSignal())
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		if err := process.Command.Process.Signal(signal); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		return &guest.SignalResponse{}, nil
	}
	return nil, status.Error(codes.NotFound, "process not found")
}

// signals maps the names callers may use onto the signal actually delivered.
// os.Interrupt is SIGINT, so SIGTERM must not be spelled with it: a process
// that ignores SIGINT but honours SIGTERM would otherwise never stop.
var signals = map[string]os.Signal{
	"SIGHUP":  syscall.SIGHUP,
	"SIGINT":  syscall.SIGINT,
	"SIGQUIT": syscall.SIGQUIT,
	"SIGKILL": syscall.SIGKILL,
	"SIGTERM": syscall.SIGTERM,
	"SIGUSR1": syscall.SIGUSR1,
	"SIGUSR2": syscall.SIGUSR2,
}

// signalForName resolves a signal name. An empty name means SIGTERM, the
// default for asking a process to stop; an unrecognised name is an error
// rather than a silent substitution.
func signalForName(name string) (os.Signal, error) {
	if name == "" {
		return syscall.SIGTERM, nil
	}
	signal, ok := signals[name]
	if !ok {
		return nil, fmt.Errorf("unknown signal %q", name)
	}
	return signal, nil
}

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
	// Replace an existing daemon with the same name: stop it first when it is
	// still running so the new process can take over. A stopped daemon is
	// replaced by Start directly.
	if existing := s.findDaemon(request.GetName()); existing != nil && existing.Running {
		if err := s.Daemons.Stop(request.GetName(), syscall.SIGTERM); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	var uid, gid *uint32
	if request.GetUid() != nil {
		value := request.GetUid().GetValue()
		if value < 0 {
			return nil, status.Error(codes.InvalidArgument, "uid must not be negative")
		}
		uid = uint32Ptr(uint32(value))
	}
	if request.GetGid() != nil {
		value := request.GetGid().GetValue()
		if value < 0 {
			return nil, status.Error(codes.InvalidArgument, "gid must not be negative")
		}
		gid = uint32Ptr(uint32(value))
	}
	name, err := s.Daemons.Start(request.GetName(), request.GetArgv(), request.GetCwd(), request.GetEnv(), daemon.StartOptions{Uid: uid, Gid: gid, Groups: request.GetGroups()})
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

func uint32Ptr(value uint32) *uint32 { return &value }

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
