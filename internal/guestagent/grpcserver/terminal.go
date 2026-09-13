// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"errors"
	"io"
	"log/slog"
	"sync"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Server) Terminal(stream guest.WorkspaceGuestAgent_TerminalServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	start := first.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "first terminal message must be start")
	}
	argv := start.GetArgv()
	argv0 := ""
	if len(argv) > 0 {
		argv0 = argv[0]
	}
	slog.Info("guest agent Terminal started", "argv0", argv0, "argc", len(argv))
	session, err := s.Terminals.Start(start.GetArgv(), start.GetCwd(), start.GetEnv(), uint16(start.GetRows()), uint16(start.GetCols()))
	if err != nil {
		return status.Error(codes.InvalidArgument, err.Error())
	}
	defer func() { _ = session.Terminate(terminalGrace) }()
	var sendMu sync.Mutex
	send := func(output *guest.TerminalOutput) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		return stream.Send(output)
	}
	if err := send(&guest.TerminalOutput{Payload: &guest.TerminalOutput_Started{Started: &guest.TerminalStarted{Pid: int32(session.Pid())}}}); err != nil {
		return err
	}
	// The exit message must follow every stdout chunk, so the exit sender waits
	// for the output reader to finish before reporting the outcome.
	stdoutDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		for chunk := range session.Output() {
			if sendErr := send(&guest.TerminalOutput{Payload: &guest.TerminalOutput_StdoutChunk{StdoutChunk: chunk}}); sendErr != nil {
				return
			}
		}
	}()
	// exitSent gates the close path so the exit message reaches the client
	// before the stream closes, letting its `done` resolve with the outcome.
	exitSent := make(chan struct{})
	go func() {
		outcome := <-session.Done()
		<-stdoutDone
		_ = send(&guest.TerminalOutput{Payload: &guest.TerminalOutput_Exit{Exit: &guest.TerminalExit{ExitCode: outcome.ExitCode, Signaled: outcome.Signaled, Signal: outcome.Signal}}})
		close(exitSent)
	}()
	for {
		input, recvErr := stream.Recv()
		if errors.Is(recvErr, io.EOF) {
			return nil
		}
		if recvErr != nil {
			return recvErr
		}
		switch payload := input.GetPayload().(type) {
		case *guest.TerminalInput_StdinChunk:
			if len(payload.StdinChunk) == 0 {
				continue
			}
			if writeErr := session.Write(payload.StdinChunk); writeErr != nil {
				return status.Error(codes.Internal, writeErr.Error())
			}
		case *guest.TerminalInput_Resize:
			if payload.Resize == nil {
				continue
			}
			if resizeErr := session.Resize(uint16(payload.Resize.GetRows()), uint16(payload.Resize.GetCols())); resizeErr != nil {
				return status.Error(codes.Internal, resizeErr.Error())
			}
		case *guest.TerminalInput_Signal:
			if payload.Signal == nil {
				continue
			}
			pgid, found := session.SignalForeground(payload.Signal.GetSignal())
			if sendErr := send(&guest.TerminalOutput{Payload: &guest.TerminalOutput_Signalled{Signalled: &guest.TerminalSignalled{RequestId: payload.Signal.GetRequestId(), Found: found, ProcessGroupId: int32(pgid)}}}); sendErr != nil {
				return sendErr
			}
		case *guest.TerminalInput_InspectRequestId:
			pgid, inputWaiting, found := session.Inspect()
			if sendErr := send(&guest.TerminalOutput{Payload: &guest.TerminalOutput_Foreground{Foreground: &guest.TerminalForeground{RequestId: payload.InspectRequestId, Found: found, ProcessGroupId: int32(pgid), InputWaiting: inputWaiting}}}); sendErr != nil {
				return sendErr
			}
		case *guest.TerminalInput_Close:
			if payload.Close {
				_ = session.Terminate(terminalGrace)
				<-exitSent
				return nil
			}
		}
	}
}
