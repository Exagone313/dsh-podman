// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package exec

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"sync"
	"syscall"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
)

type Process struct {
	ID      string
	Argv    []string
	Command *exec.Cmd
}

type Manager struct {
	mu        sync.Mutex
	nextID    uint64
	processes map[string]*Process
	paths     *childenv.Paths
}

func NewManager(paths *childenv.Paths) *Manager {
	return &Manager{processes: make(map[string]*Process), paths: paths}
}

func (m *Manager) Start(ctx context.Context, argv []string, cwd string, env map[string]string, opts identity.Options, unset ...string) (*Process, error) {
	if len(argv) == 0 || argv[0] == "" {
		return nil, fmt.Errorf("argv must contain a command")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = cwd
	// Always set the environment explicitly: leaving cmd.Env nil would make
	// the child inherit the agent's own, reserved variables included.
	cmd.Env = childenv.Build(m.paths, env, unset...)
	// A requested identity is applied through the process credential; with no
	// override the child keeps the agent's own identity.
	//
	// Every command also leads its own process group, so a signal (a caller's
	// kill, or a timeout) reaches the whole command tree: a shell defers a
	// signal while its foreground child runs, so signalling only the direct
	// child would leave that child alive.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if cred := identity.Credential(opts); cred != nil {
		cmd.SysProcAttr.Credential = cred
	}
	proc := &Process{Argv: append([]string(nil), argv...), Command: cmd}
	m.mu.Lock()
	m.nextID++
	proc.ID = strconv.FormatUint(m.nextID, 10)
	m.processes[proc.ID] = proc
	m.mu.Unlock()
	return proc, nil
}

func (m *Manager) Remove(id string) {
	m.mu.Lock()
	delete(m.processes, id)
	m.mu.Unlock()
}

func (m *Manager) List() []*Process {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]*Process, 0, len(m.processes))
	for _, process := range m.processes {
		result = append(result, process)
	}
	return result
}
