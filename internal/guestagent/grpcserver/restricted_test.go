// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"strings"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// restrictedDecision is the restricted-mode decision for one guest RPC.
type restrictedDecision struct {
	allow bool
}

// restrictedDecisions is the complete decision table for the
// WorkspaceGuestAgent service. It is intentionally explicit per method: the
// test enumerates the generated service descriptor, so adding an RPC without
// adding a decision here fails the test instead of silently falling through.
var restrictedDecisions = map[string]restrictedDecision{
	// Allowed: starting an exec (its first frame is ExecStart), its control
	// channel, the capability probe, and the plugin's readiness ping.
	guest.WorkspaceGuestAgent_Exec_FullMethodName:            {allow: true},
	guest.WorkspaceGuestAgent_ExecControl_FullMethodName:     {allow: true},
	guest.WorkspaceGuestAgent_GetCapabilities_FullMethodName: {allow: true},
	guest.WorkspaceGuestAgent_Ping_FullMethodName:            {allow: true},

	// Refused: everything else, including process signalling, filesystem
	// access, paths, daemons, port publishing, and terminals.
	guest.WorkspaceGuestAgent_Signal_FullMethodName:         {allow: false},
	guest.WorkspaceGuestAgent_ReadFile_FullMethodName:       {allow: false},
	guest.WorkspaceGuestAgent_WriteFile_FullMethodName:      {allow: false},
	guest.WorkspaceGuestAgent_Stat_FullMethodName:           {allow: false},
	guest.WorkspaceGuestAgent_ReadDir_FullMethodName:        {allow: false},
	guest.WorkspaceGuestAgent_Mkdir_FullMethodName:          {allow: false},
	guest.WorkspaceGuestAgent_Delete_FullMethodName:         {allow: false},
	guest.WorkspaceGuestAgent_SetPaths_FullMethodName:       {allow: false},
	guest.WorkspaceGuestAgent_GetPaths_FullMethodName:       {allow: false},
	guest.WorkspaceGuestAgent_StartDaemon_FullMethodName:    {allow: false},
	guest.WorkspaceGuestAgent_ListDaemons_FullMethodName:    {allow: false},
	guest.WorkspaceGuestAgent_StopDaemon_FullMethodName:     {allow: false},
	guest.WorkspaceGuestAgent_StopAllDaemons_FullMethodName: {allow: false},
	guest.WorkspaceGuestAgent_RestartDaemon_FullMethodName:  {allow: false},
	guest.WorkspaceGuestAgent_DaemonLogs_FullMethodName:     {allow: false},
	guest.WorkspaceGuestAgent_PublishPort_FullMethodName:    {allow: false},
	guest.WorkspaceGuestAgent_UnpublishPort_FullMethodName:  {allow: false},
	guest.WorkspaceGuestAgent_Terminal_FullMethodName:       {allow: false},
}

// guestServiceDescriptor returns the generated WorkspaceGuestAgent descriptor.
func guestServiceDescriptor(t *testing.T) protoreflect.ServiceDescriptor {
	t.Helper()
	service := guest.File_dshguest_v1_guest_proto.Services().ByName("WorkspaceGuestAgent")
	if service == nil {
		t.Fatal("WorkspaceGuestAgent service descriptor is missing from the generated proto")
	}
	return service
}

// guardStream is a fake ServerStream; the interceptors only ask for its context
// and hand it to the handler, so no transport is needed.
type guardStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s *guardStream) Context() context.Context { return s.ctx }

// invokeUnary runs the unary interceptor with a fake handler and reports
// whether the handler was reached.
func invokeUnary(interceptor grpc.UnaryServerInterceptor, fullMethod string) (bool, error) {
	called := false
	_, err := interceptor(
		context.Background(),
		nil,
		&grpc.UnaryServerInfo{FullMethod: fullMethod},
		func(context.Context, any) (any, error) {
			called = true
			return "handled", nil
		},
	)
	return called, err
}

// invokeStream runs the stream interceptor with a fake stream and handler and
// reports whether the handler was reached.
func invokeStream(interceptor grpc.StreamServerInterceptor, fullMethod string) (bool, error) {
	called := false
	err := interceptor(
		nil,
		&guardStream{ctx: context.Background()},
		&grpc.StreamServerInfo{FullMethod: fullMethod},
		func(any, grpc.ServerStream) error {
			called = true
			return nil
		},
	)
	return called, err
}

// TestPTCGuardMethodTable drives both interceptors over every RPC in the
// generated service descriptor. In PTC mode the allow-listed methods pass
// through and every other method is refused with PermissionDenied naming the
// method and the reserved container; outside PTC mode nothing is refused.
func TestPTCGuardMethodTable(t *testing.T) {
	service := guestServiceDescriptor(t)
	methods := service.Methods()
	if methods.Len() == 0 {
		t.Fatal("WorkspaceGuestAgent descriptor has no methods")
	}
	seen := make(map[string]bool, methods.Len())
	for i := 0; i < methods.Len(); i++ {
		method := methods.Get(i)
		fullMethod := fmt.Sprintf("/%s/%s", service.FullName(), method.Name())
		decision, ok := restrictedDecisions[fullMethod]
		if !ok {
			t.Errorf("guest RPC %s has no restricted-mode decision; add it to restrictedDecisions", fullMethod)
			continue
		}
		seen[fullMethod] = true
		t.Run(string(method.Name()), func(t *testing.T) {
			t.Run("ptc unary", func(t *testing.T) {
				called, err := invokeUnary(PTCUnary(), fullMethod)
				assertGuardResult(t, decision.allow, called, err, fullMethod)
			})
			t.Run("ptc stream", func(t *testing.T) {
				called, err := invokeStream(PTCStream(), fullMethod)
				assertGuardResult(t, decision.allow, called, err, fullMethod)
			})
			t.Run("normal unary", func(t *testing.T) {
				called, err := invokeUnary(ptcUnary(false), fullMethod)
				if err != nil || !called {
					t.Fatalf("normal mode refused %s: called=%v err=%v", fullMethod, called, err)
				}
			})
			t.Run("normal stream", func(t *testing.T) {
				called, err := invokeStream(ptcStream(false), fullMethod)
				if err != nil || !called {
					t.Fatalf("normal mode refused %s: called=%v err=%v", fullMethod, called, err)
				}
			})
		})
	}
	for fullMethod := range restrictedDecisions {
		if !seen[fullMethod] {
			t.Errorf("restrictedDecisions names %s, which is not a WorkspaceGuestAgent RPC", fullMethod)
		}
	}
}

// assertGuardResult checks one interceptor invocation against its decision.
func assertGuardResult(t *testing.T, allow, called bool, err error, fullMethod string) {
	t.Helper()
	if allow {
		if err != nil || !called {
			t.Fatalf("PTC mode refused allowed method %s: called=%v err=%v", fullMethod, called, err)
		}
		return
	}
	if called {
		t.Fatalf("PTC mode passed refused method %s through to its handler", fullMethod)
	}
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("PTC mode returned %v for refused method %s, want PermissionDenied", err, fullMethod)
	}
	if !strings.Contains(err.Error(), fullMethod) {
		t.Errorf("refusal %q does not name the method %s", err, fullMethod)
	}
	if !strings.Contains(err.Error(), ptcContainerName) {
		t.Errorf("refusal %q does not name the reserved container %q", err, ptcContainerName)
	}
}
