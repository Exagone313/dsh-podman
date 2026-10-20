// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// controlStream is a fake ExecControl server stream whose frames are fed and
// collected through channels, so a test can keep the channel open and react to
// the relay without racing the handler.
type controlStream struct {
	grpc.ServerStream
	ctx     context.Context
	inputs  chan *guest.ExecControlFrame
	outputs chan *guest.ExecControlFrame
}

func newControlStream(ctx context.Context) *controlStream {
	return &controlStream{
		ctx:     ctx,
		inputs:  make(chan *guest.ExecControlFrame, 16),
		outputs: make(chan *guest.ExecControlFrame, 64),
	}
}

func (s *controlStream) Context() context.Context { return s.ctx }

func (s *controlStream) Send(frame *guest.ExecControlFrame) error {
	select {
	case s.outputs <- frame:
		return nil
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}

func (s *controlStream) Recv() (*guest.ExecControlFrame, error) {
	select {
	case frame, ok := <-s.inputs:
		if !ok {
			return nil, io.EOF
		}
		return frame, nil
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
}

func controlIdentity(id string) *guest.ExecControlFrame {
	return &guest.ExecControlFrame{Payload: &guest.ExecControlFrame_ExecId{ExecId: id}}
}

func controlData(data string) *guest.ExecControlFrame {
	return &guest.ExecControlFrame{Payload: &guest.ExecControlFrame_Data{Data: []byte(data)}}
}

func nextControlFrame(t *testing.T, stream *controlStream) *guest.ExecControlFrame {
	t.Helper()
	select {
	case frame := <-stream.outputs:
		return frame
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for a control frame")
		return nil
	}
}

func runControlRelay(t *testing.T, ctx context.Context, server *Server, stream *controlStream) chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- server.ExecControl(stream) }()
	return done
}

// startControlExec runs one control-requesting exec and waits until its
// endpoint is registered, so a test can attach the ExecControl stream before
// the child exits. Each test uses a fresh server, so the first exec is 1.
func startControlExec(t *testing.T, server *Server, root, script string) (*execStream, chan error) {
	t.Helper()
	exec := &execStream{inputs: []*guest.ExecInput{{
		Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv:    []string{"sh", "-c", script},
			Cwd:     root,
			Control: true,
		}},
	}}}
	done := make(chan error, 1)
	go func() { done <- server.Exec(exec) }()
	waitForControlEndpoint(t, server, "1")
	return exec, done
}

func waitForControlEndpoint(t *testing.T, server *Server, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if server.Controls.has(id) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("exec %s did not register a control channel", id)
}

func waitFor(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for the handler to return")
		return nil
	}
}

func TestExecControlProtoRoundTrip(t *testing.T) {
	start := &guest.ExecStart{Argv: []string{"node"}, Control: true}
	encoded, err := proto.Marshal(start)
	if err != nil {
		t.Fatal(err)
	}
	var decoded guest.ExecStart
	if err := proto.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.GetControl() {
		t.Fatal("control flag did not survive the round trip")
	}
	field := guest.File_dshguest_v1_guest_proto.Messages().ByName("ExecStart").Fields().ByName("control")
	if field == nil || field.Number() != 11 {
		t.Fatalf("control must be field 11, got %#v", field)
	}
	service := guest.File_dshguest_v1_guest_proto.Services().ByName("WorkspaceGuestAgent")
	for _, method := range []string{"GetCapabilities", "ExecControl"} {
		if service.Methods().ByName(protoreflect.Name(method)) == nil {
			t.Fatalf("service is missing %s", method)
		}
	}
	// The hand-maintained gRPC bindings must stay in step with the descriptor:
	// the capability probe is unary and the control channel is bidirectional.
	unary := false
	for _, method := range guest.WorkspaceGuestAgent_ServiceDesc.Methods {
		if method.MethodName == "GetCapabilities" {
			unary = true
		}
	}
	if !unary {
		t.Fatal("service descriptor is missing GetCapabilities")
	}
	var stream *grpc.StreamDesc
	for index := range guest.WorkspaceGuestAgent_ServiceDesc.Streams {
		if guest.WorkspaceGuestAgent_ServiceDesc.Streams[index].StreamName == "ExecControl" {
			stream = &guest.WorkspaceGuestAgent_ServiceDesc.Streams[index]
		}
	}
	if stream == nil || !stream.ServerStreams || !stream.ClientStreams {
		t.Fatalf("service descriptor must describe ExecControl as bidirectional, got %#v", stream)
	}
	if guest.WorkspaceGuestAgent_ExecControl_FullMethodName != "/dshguest.v1.WorkspaceGuestAgent/ExecControl" {
		t.Fatalf("unexpected ExecControl method name %q", guest.WorkspaceGuestAgent_ExecControl_FullMethodName)
	}
	frames := []*guest.ExecControlFrame{
		controlIdentity("42"),
		controlData("opaque\x00bytes"),
	}
	for _, frame := range frames {
		encoded, err := proto.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		var decoded guest.ExecControlFrame
		if err := proto.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		if string(decoded.GetExecId()) != string(frame.GetExecId()) || string(decoded.GetData()) != string(frame.GetData()) {
			t.Fatalf("frame did not survive the round trip: %#v != %#v", decoded.GetPayload(), frame.GetPayload())
		}
	}
}

func TestGetCapabilitiesReportsExecControl(t *testing.T) {
	server := New()
	response, err := server.GetCapabilities(context.Background(), &guest.GetCapabilitiesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if !response.GetExecControl() {
		t.Fatal("agent should report exec control support")
	}
}

func TestExecControlRelaysBothDirections(t *testing.T) {
	server, root := newTestServer(t)
	exec, execDone := startControlExec(t, server, root,
		`read first <&7; printf 'echo:%s' "$first" >&7; read second <&7; printf '|%s' "$second" >&7`)
	control := newControlStream(context.Background())
	control.inputs <- controlIdentity("1")
	controlDone := runControlRelay(t, context.Background(), server, control)

	control.inputs <- controlData("hello\n")
	if frame := nextControlFrame(t, control); string(frame.GetData()) != "echo:hello" {
		t.Fatalf("child output = %q, want echo:hello", frame.GetData())
	}
	control.inputs <- controlData("world\n")
	if frame := nextControlFrame(t, control); string(frame.GetData()) != "|world" {
		t.Fatalf("child output = %q, want |world", frame.GetData())
	}
	// The child exits after its last write, so the send side closes on its own.
	if err := waitFor(t, controlDone); err != nil {
		t.Fatalf("control relay returned %v", err)
	}
	close(control.inputs)
	if err := waitFor(t, execDone); err != nil {
		t.Fatal(err)
	}
	if exit := exec.exit(); exit == nil || exit.GetExitCode() != 0 {
		t.Fatalf("expected a clean exit, got %#v", exit)
	}
}

func TestExecControlPassesCallerEOFToTheChild(t *testing.T) {
	server, root := newTestServer(t)
	exec, execDone := startControlExec(t, server, root, `cat <&7 >&7`)
	control := newControlStream(context.Background())
	control.inputs <- controlIdentity("1")
	controlDone := runControlRelay(t, context.Background(), server, control)

	control.inputs <- controlData("ping")
	if frame := nextControlFrame(t, control); string(frame.GetData()) != "ping" {
		t.Fatalf("child output = %q, want ping", frame.GetData())
	}
	// The caller closing its half must reach the child as EOF: cat then exits.
	close(control.inputs)
	if err := waitFor(t, controlDone); err != nil {
		t.Fatalf("control relay returned %v", err)
	}
	if err := waitFor(t, execDone); err != nil {
		t.Fatal(err)
	}
	if exit := exec.exit(); exit == nil || exit.GetExitCode() != 0 {
		t.Fatalf("expected a clean exit, got %#v", exit)
	}
}

func TestExecControlEndsWhenTheExecExits(t *testing.T) {
	server, root := newTestServer(t)
	exec, execDone := startControlExec(t, server, root, `read line <&7; printf done >&7`)
	control := newControlStream(context.Background())
	control.inputs <- controlIdentity("1")
	controlDone := runControlRelay(t, context.Background(), server, control)

	control.inputs <- controlData("go\n")
	if frame := nextControlFrame(t, control); string(frame.GetData()) != "done" {
		t.Fatalf("child output = %q, want done", frame.GetData())
	}
	// The caller keeps its half open; the child exiting must end the stream.
	if err := waitFor(t, controlDone); err != nil {
		t.Fatalf("control relay returned %v", err)
	}
	close(control.inputs)
	if err := waitFor(t, execDone); err != nil {
		t.Fatal(err)
	}
	if exit := exec.exit(); exit == nil || exit.GetExitCode() != 0 {
		t.Fatalf("expected a clean exit, got %#v", exit)
	}
}

func TestExecControlStopsOnCancellation(t *testing.T) {
	server, root := newTestServer(t)
	exec, execDone := startControlExec(t, server, root, `cat <&7 >&7`)
	ctx, cancel := context.WithCancel(context.Background())
	control := newControlStream(ctx)
	control.inputs <- controlIdentity("1")
	controlDone := runControlRelay(t, ctx, server, control)
	// Confirm the stream is attached before cancelling it; a cancellation that
	// lands before attachment would leave the child untouched.
	control.inputs <- controlData("ready")
	if frame := nextControlFrame(t, control); string(frame.GetData()) != "ready" {
		t.Fatalf("child output = %q, want ready", frame.GetData())
	}
	cancel()

	// Cancelling the stream closes the endpoint, which lets the child's cat see
	// EOF and exit.
	if err := waitFor(t, controlDone); !errors.Is(err, context.Canceled) {
		t.Fatalf("control relay returned %v, want context.Canceled", err)
	}
	if err := waitFor(t, execDone); err != nil {
		t.Fatal(err)
	}
	if exit := exec.exit(); exit == nil || exit.GetExitCode() != 0 {
		t.Fatalf("expected a clean exit, got %#v", exit)
	}
}

func TestExecControlRefusesAnUnsupportedRequest(t *testing.T) {
	original := controlSocketpair
	controlSocketpair = func() (*net.UnixConn, *os.File, error) {
		return nil, nil, errors.New("socketpair unavailable")
	}
	t.Cleanup(func() { controlSocketpair = original })

	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{{
		Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv:    []string{"sh", "-c", "true"},
			Cwd:     root,
			Control: true,
		}},
	}}}
	err := server.Exec(stream)
	if status.Code(err) != codes.Unavailable {
		t.Fatalf("expected Unavailable, got %v", err)
	}
	if !strings.Contains(err.Error(), "control channel") {
		t.Fatalf("error should name the control channel: %v", err)
	}
	if len(server.Processes.List()) != 0 {
		t.Fatalf("refused exec left a process registered: %#v", server.Processes.List())
	}
}

func TestExecControlAttachesToFD7(t *testing.T) {
	server, root := newTestServer(t)
	stream := &execStream{inputs: []*guest.ExecInput{{
		Payload: &guest.ExecInput_Start{Start: &guest.ExecStart{
			Argv:    []string{"sh", "-c", `if [ -S /proc/self/fd/7 ]; then printf socket; else printf other; fi`},
			Cwd:     root,
			Control: true,
		}},
	}}}
	if err := server.Exec(stream); err != nil {
		t.Fatal(err)
	}
	if got := stream.stdout(); got != "socket" {
		t.Fatalf("fd 7 = %q, want a socket", got)
	}
}
