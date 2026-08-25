package grpcserver

import (
	"context"
	"errors"
	"io"
	"os"
	osexec "os/exec"
	"strconv"
	"sync"

	"dsh-container-plugin/internal/agent/exec"
	agent "dsh-container-plugin/internal/genproto/dshagent/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Server struct {
	agent.UnimplementedWorkspaceAgentServer
	Processes *exec.Manager
}

func New() *Server { return &Server{Processes: exec.NewManager()} }

func (s *Server) Exec(stream agent.WorkspaceAgent_ExecServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	start := first.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "first exec message must be start")
	}
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
	send := func(output *agent.ExecOutput) error {
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
				output := &agent.ExecOutput{}
				if stderr {
					output.Payload = &agent.ExecOutput_StderrChunk{StderrChunk: data}
				} else {
					output.Payload = &agent.ExecOutput_StdoutChunk{StdoutChunk: data}
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
	if err := send(&agent.ExecOutput{Payload: &agent.ExecOutput_Exit{Exit: &agent.ExecExit{ExitCode: exit, Signaled: signaled, Signal: signalName}}}); err != nil {
		return err
	}
	return nil
}

func (s *Server) Signal(_ context.Context, request *agent.SignalRequest) (*agent.SignalResponse, error) {
	for _, process := range s.Processes.List() {
		if process.ID == request.GetProcessId() {
			if err := process.Command.Process.Signal(signalForName(request.GetSignal())); err != nil {
				return nil, status.Error(codes.Internal, err.Error())
			}
			return &agent.SignalResponse{}, nil
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

func (s *Server) ListProcesses(context.Context, *agent.ListProcessesRequest) (*agent.ListProcessesResponse, error) {
	result := &agent.ListProcessesResponse{}
	for _, process := range s.Processes.List() {
		running := process.Command.ProcessState == nil
		result.Processes = append(result.Processes, &agent.ProcessInfo{ProcessId: process.ID, Argv: process.Argv, Running: running})
	}
	return result, nil
}

func (s *Server) ValidateProcessID(id string) bool {
	_, err := strconv.ParseUint(id, 10, 64)
	return err == nil
}
