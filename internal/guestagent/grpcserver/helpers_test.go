// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	workspacefs "github.com/Exagone313/dsh-podman/internal/guestagent/fs"
	"google.golang.org/grpc"
)

func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	filesystem, err := workspacefs.New([]workspacefs.Mount{{Virtual: "/workspace", Host: root}})
	if err != nil {
		t.Fatal(err)
	}
	return New().WithFS(filesystem), root
}

// readFileStream collects the chunks a ReadFile handler sends.
type readFileStream struct {
	grpc.ServerStream
	chunks [][]byte
}

func (s *readFileStream) Send(chunk *guest.ReadFileChunk) error {
	s.chunks = append(s.chunks, append([]byte(nil), chunk.GetData()...))
	return nil
}

func (s *readFileStream) data() string {
	return string(bytes.Join(s.chunks, nil))
}

// execStream is a fake Exec server stream: it replays queued inputs and records
// every output the handler sends.
type execStream struct {
	grpc.ServerStream
	inputs  []*guest.ExecInput
	outputs []*guest.ExecOutput
	index   int
}

func (s *execStream) Send(output *guest.ExecOutput) error {
	s.outputs = append(s.outputs, output)
	return nil
}

func (s *execStream) Context() context.Context {
	return context.Background()
}

func (s *execStream) Recv() (*guest.ExecInput, error) {
	if s.index >= len(s.inputs) {
		return nil, io.EOF
	}
	input := s.inputs[s.index]
	s.index++
	return input, nil
}

func (s *execStream) exit() *guest.ExecExit {
	for _, output := range s.outputs {
		if exit := output.GetExit(); exit != nil {
			return exit
		}
	}
	return nil
}

func (s *execStream) stdout() string {
	var builder strings.Builder
	for _, output := range s.outputs {
		builder.Write(output.GetStdoutChunk())
	}
	return builder.String()
}

func waitDaemonState(t *testing.T, server *Server, name string, running bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := server.ListDaemons(context.Background(), &guest.ListDaemonsRequest{})
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range response.Daemons {
			if d.Name == name && d.Running == running {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("daemon %q did not reach running=%v in time", name, running)
}

// writeFileStream feeds a WriteFile handler a fixed chunk list and captures the
// final response.
type writeFileStream struct {
	grpc.ServerStream
	chunks []*guest.WriteFileChunk
	index  int
	result *guest.WriteFileResponse
}

func (s *writeFileStream) Recv() (*guest.WriteFileChunk, error) {
	if s.index >= len(s.chunks) {
		return nil, io.EOF
	}
	chunk := s.chunks[s.index]
	s.index++
	return chunk, nil
}

func (s *writeFileStream) SendAndClose(response *guest.WriteFileResponse) error {
	s.result = response
	return nil
}
