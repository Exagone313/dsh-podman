// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"syscall"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// controlFD is the descriptor the PTC child opens for its control channel.
// Go starts ExtraFiles at descriptor 3, so the slice is padded with inert
// descriptors until the child's socketpair end lands on this number.
const controlFD = 7

// controlPadding is the number of inert descriptors ExtraFiles needs before the
// child's control end.
const controlPadding = controlFD - 3

var (
	errControlUnknown  = errors.New("exec has no control channel")
	errControlAttached = errors.New("exec control channel is already attached")
)

// controlRegistry is the rendezvous between an exec and its ExecControl
// stream. They are separate RPCs, so Exec registers the parent end of the
// socketpair before the child can use fd 7, and the stream handler attaches
// when the caller opens it.
type controlRegistry struct {
	mu      sync.Mutex
	entries map[string]*controlEntry
}

// controlEntry is one exec's registered control endpoint. attached is written
// and read only under the registry mutex; the connection itself is closed by
// the stream handler (when one attached) or by finish (when none did).
type controlEntry struct {
	conn      *net.UnixConn
	attached  bool
	closeOnce sync.Once
}

func newControlRegistry() *controlRegistry {
	return &controlRegistry{entries: make(map[string]*controlEntry)}
}

func (r *controlRegistry) register(id string, conn *net.UnixConn) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.entries[id]; exists {
		return fmt.Errorf("exec %s already has a control channel", id)
	}
	r.entries[id] = &controlEntry{conn: conn}
	return nil
}

func (r *controlRegistry) attach(id string) (*controlEntry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, ok := r.entries[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", errControlUnknown, id)
	}
	if entry.attached {
		return nil, fmt.Errorf("%w: %s", errControlAttached, id)
	}
	entry.attached = true
	return entry, nil
}

// finish drops an exec's entry once the process is gone. An entry no stream
// attached is closed here; an attached one is left open so its handler can
// still drain the bytes the child wrote before it exited, and the handler
// closes it when it returns.
func (r *controlRegistry) finish(id string) {
	r.mu.Lock()
	entry, ok := r.entries[id]
	attached := false
	if ok {
		attached = entry.attached
		delete(r.entries, id)
	}
	r.mu.Unlock()
	if ok && !attached {
		entry.close()
	}
}

// has reports whether an exec currently has a control endpoint. It is used by
// the tests to wait for registration without racing the Exec handler.
func (r *controlRegistry) has(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.entries[id]
	return ok
}

func (e *controlEntry) close() {
	e.closeOnce.Do(func() { _ = e.conn.Close() })
}

// controlChannel owns the agent-side descriptors of one exec's control
// channel. The parent conn is held by the registry; child is the socketpair
// end handed to the process, and pads fill the ExtraFiles slots before it.
type controlChannel struct {
	child *os.File
	pads  []*os.File
}

// newControlChannel creates the socketpair for one exec and registers its
// parent end. The caller must close the child end once the command started.
func (s *Server) newControlChannel(id string) (*controlChannel, error) {
	parent, child, err := controlSocketpair()
	if err != nil {
		return nil, err
	}
	pads, err := openControlPadding(controlPadding)
	if err != nil {
		_ = parent.Close()
		_ = child.Close()
		return nil, err
	}
	if err := s.Controls.register(id, parent); err != nil {
		_ = parent.Close()
		_ = child.Close()
		closeControlFiles(pads)
		return nil, err
	}
	return &controlChannel{child: child, pads: pads}, nil
}

// extraFiles returns the descriptor slice that places child on fd 7: the pads
// occupy descriptors 3 through 6.
func (c *controlChannel) extraFiles() []*os.File {
	files := make([]*os.File, 0, controlPadding+1)
	files = append(files, c.pads...)
	return append(files, c.child)
}

// closeChild closes the agent's copies of the child end and the pads. Keeping
// them open would stop the socket from ever reaching EOF when the process
// exits. It is idempotent.
func (c *controlChannel) closeChild() {
	if c.child != nil {
		_ = c.child.Close()
		c.child = nil
	}
	closeControlFiles(c.pads)
	c.pads = nil
}

func (c *controlChannel) close() { c.closeChild() }

func closeControlFiles(files []*os.File) {
	for _, file := range files {
		_ = file.Close()
	}
}

// controlSocketpair is a test seam for the refusal path: production always
// uses newControlSocketpair.
var controlSocketpair = newControlSocketpair

// newControlSocketpair returns the agent's end and the child's end of a Unix
// stream socketpair. The agent's end is wrapped in a net.UnixConn so closing
// it from another goroutine unblocks a pending read.
func newControlSocketpair() (*net.UnixConn, *os.File, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("control socketpair: %w", err)
	}
	child := os.NewFile(uintptr(fds[1]), "dsh-control-child")
	parentFile := os.NewFile(uintptr(fds[0]), "dsh-control")
	conn, err := net.FileConn(parentFile)
	_ = parentFile.Close()
	if err != nil {
		_ = child.Close()
		return nil, nil, fmt.Errorf("control socket: %w", err)
	}
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		_ = conn.Close()
		_ = child.Close()
		return nil, nil, fmt.Errorf("control socket is not a Unix stream")
	}
	return unixConn, child, nil
}

// openControlPadding opens count inert descriptors for the ExtraFiles slots
// between the standard descriptors and fd 7.
func openControlPadding(count int) ([]*os.File, error) {
	files := make([]*os.File, 0, count)
	for index := 0; index < count; index++ {
		file, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
		if err != nil {
			closeControlFiles(files)
			return nil, fmt.Errorf("control padding: %w", err)
		}
		files = append(files, file)
	}
	return files, nil
}

// controlSupported reports whether this agent can attach the fd-7 control
// channel. The transport is a Unix socketpair, which this agent's build
// provides.
func controlSupported() bool { return true }

// GetCapabilities reports the optional features this agent implements, so a
// caller can fall back when it talks to an older agent.
func (s *Server) GetCapabilities(context.Context, *guest.GetCapabilitiesRequest) (*guest.GetCapabilitiesResponse, error) {
	return &guest.GetCapabilitiesResponse{ExecControl: controlSupported()}, nil
}

// ExecControl relays opaque bytes between the caller and one exec's fd 7. The
// first frame names the exec; the stream then stays open until the child exits,
// the caller closes its half, or either side fails.
func (s *Server) ExecControl(stream guest.WorkspaceGuestAgent_ExecControlServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	execID := first.GetExecId()
	if execID == "" {
		return status.Error(codes.InvalidArgument, "first exec control frame must name the exec")
	}
	entry, err := s.Controls.attach(execID)
	if err != nil {
		if errors.Is(err, errControlAttached) {
			return status.Error(codes.FailedPrecondition, err.Error())
		}
		return status.Error(codes.NotFound, err.Error())
	}
	defer entry.close()
	sendDone := make(chan error, 1)
	go forwardControlOutput(stream, entry, sendDone)
	recvDone := make(chan error, 1)
	go forwardControlInput(stream, entry, recvDone)
	select {
	case err := <-sendDone:
		// The child closed its end (or the send failed). Nothing is left to
		// forward, so close the caller's side as well.
		entry.close()
		return err
	case err := <-recvDone:
		if err != nil {
			entry.close()
			return err
		}
		// The caller half-closed the channel. The child has seen EOF and may
		// still be producing its final frames, so keep sending until it exits.
		select {
		case err := <-sendDone:
			return err
		case <-stream.Context().Done():
			return stream.Context().Err()
		}
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
}

// forwardControlOutput copies the child's fd-7 output to the caller. It
// reports exactly once on done; a clean EOF is a nil error.
func forwardControlOutput(stream guest.WorkspaceGuestAgent_ExecControlServer, entry *controlEntry, done chan<- error) {
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := entry.conn.Read(buffer)
		if n > 0 {
			data := append([]byte(nil), buffer[:n]...)
			frame := &guest.ExecControlFrame{Payload: &guest.ExecControlFrame_Data{Data: data}}
			if sendErr := stream.Send(frame); sendErr != nil {
				done <- sendErr
				return
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				done <- nil
			} else {
				done <- readErr
			}
			return
		}
	}
}

// forwardControlInput copies the caller's frames to the child's fd 7. A
// caller half-close is passed through as a socket half-close so a reader on
// fd 7 sees EOF.
func forwardControlInput(stream guest.WorkspaceGuestAgent_ExecControlServer, entry *controlEntry, done chan<- error) {
	for {
		frame, recvErr := stream.Recv()
		if recvErr != nil {
			if errors.Is(recvErr, io.EOF) {
				if closeErr := entry.conn.CloseWrite(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
					done <- closeErr
					return
				}
				done <- nil
			} else {
				done <- recvErr
			}
			return
		}
		if data := frame.GetData(); len(data) > 0 {
			if _, writeErr := entry.conn.Write(data); writeErr != nil {
				done <- writeErr
				return
			}
		}
	}
}
