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
}

func NewManager() *Manager { return &Manager{processes: make(map[string]*Process)} }

func (m *Manager) Start(ctx context.Context, argv []string, cwd string, env map[string]string) (*Process, error) {
	if len(argv) == 0 || argv[0] == "" {
		return nil, fmt.Errorf("argv must contain a command")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = cwd
	if len(env) != 0 {
		cmd.Env = os.Environ()
		for key, value := range env {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
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
