// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"errors"
	"strconv"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
	"github.com/Exagone313/dsh-podman/internal/guestagent/daemon"
	"github.com/Exagone313/dsh-podman/internal/guestagent/exec"
	workspacefs "github.com/Exagone313/dsh-podman/internal/guestagent/fs"
	"github.com/Exagone313/dsh-podman/internal/guestagent/publish"
	"github.com/Exagone313/dsh-podman/internal/guestagent/terminal"
)

// terminalGrace is how long a terminal process group is given to stop after
// SIGTERM before it is killed.
const terminalGrace = 5 * time.Second

type Server struct {
	guest.UnimplementedWorkspaceGuestAgentServer
	Processes *exec.Manager
	Daemons   *daemon.Manager
	Terminals *terminal.Manager
	FS        *workspacefs.WorkspaceFS
	// Publish owns the Unix sockets this container publishes for pod ports.
	// It is nil until WithPublish configures a socket directory.
	Publish *publish.Manager
	// Paths holds the additions prepended to every child's PATH.
	Paths *childenv.Paths
}

func New() *Server {
	paths := childenv.NewPaths()
	return &Server{
		Processes: exec.NewManager(paths),
		Daemons:   daemon.NewManager(paths),
		Terminals: terminal.NewManager(paths),
		Paths:     paths,
	}
}

func (s *Server) WithFS(filesystem *workspacefs.WorkspaceFS) *Server { s.FS = filesystem; return s }

// WithPublish enables port publishing, using dir as the container's socket
// directory.
func (s *Server) WithPublish(dir string) *Server {
	s.Publish = publish.New(dir)
	return s
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

func (s *Server) resolveEntry(path string) (string, error) {
	if s.FS == nil {
		return "", errors.New("filesystem is not configured")
	}
	return s.FS.ResolveEntry(path)
}
