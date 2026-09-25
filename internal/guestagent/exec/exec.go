// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package exec

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
)

// cancelGrace bounds how long Wait may wait for a cancelled command's output
// pipes to close once the process group has been killed.
const cancelGrace = 5 * time.Second

type Process struct {
	ID      string
	Argv    []string
	Command *exec.Cmd

	// process is Command.Process once the command has started. Command.Process
	// is written by Command.Start on the starting goroutine while Signal may
	// read it from another, so the started handle is published and read under
	// this mutex instead of through Command.
	mu      sync.Mutex
	process *os.Process
}

// SetProcess publishes the started OS process.
func (p *Process) SetProcess(handle *os.Process) {
	p.mu.Lock()
	p.process = handle
	p.mu.Unlock()
}

// ProcessHandle returns the started OS process, or nil before Start succeeds.
func (p *Process) ProcessHandle() *os.Process {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.process
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
	// A cancelled context must stop the whole command group, not just the
	// direct child: the caller cancels the exec stream on a timeout or an
	// abort, and the default cancellation kills only the child, leaving a
	// shell's foreground child running. The kill is best-effort, and returning
	// no error keeps a process that exited on its own from turning Wait's
	// result into a cancellation error. WaitDelay bounds Wait when a surviving
	// grandchild still holds the output pipes.
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
				_ = cmd.Process.Kill()
			}
		}
		return nil
	}
	cmd.WaitDelay = cancelGrace
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
