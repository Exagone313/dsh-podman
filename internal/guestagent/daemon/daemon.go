// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
)

var (
	ErrAlreadyRunning = errors.New("daemon already running")
	ErrUnknown        = errors.New("unknown daemon")
	// ErrInvalidName is a name that cannot be a daemon name.
	ErrInvalidName = errors.New("invalid daemon name")
	// ErrTooMany is returned when the manager already tracks its cap of daemons
	// and none of them is stoppable.
	ErrTooMany = errors.New("too many daemons")
)

const (
	ringCapacity = 256 * 1024
	stopGrace    = 10 * time.Second
	// maxDaemons bounds the tracked set. Each tracked daemon holds two 256 KiB
	// capture rings, so an unbounded map is a memory leak a caller could drive
	// by starting daemons under ever-new names.
	maxDaemons = 64
)

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

// Daemon is a snapshot of a tracked background process.
type Daemon struct {
	Name      string
	Argv      []string
	Running   bool
	ExitCode  int32
	StartedAt string
	StoppedAt string
	Uid       uint32
	Gid       uint32
	Groups    []uint32
}

// StartOptions carries optional process identity settings. When neither Uid
// nor Gid is set (and no supplementary groups are requested), the process runs
// as the container's default user.
type StartOptions struct {
	Uid, Gid *uint32
	Groups   []uint32
	// IsolatedEnv withholds the agent's own environment from the daemon: it
	// receives only the childenv baseline (PATH, HOME) plus the caller's env.
	IsolatedEnv bool
}

type daemon struct {
	info        Daemon
	cmd         *exec.Cmd
	cwd         string
	env         map[string]string
	isolatedEnv bool
	uid         *uint32
	gid         *uint32
	groups      []uint32
	stdout      *ring
	stderr      *ring
}

// Manager tracks daemons spawned detached from any RPC request context.
type Manager struct {
	mu      sync.Mutex
	daemons map[string]*daemon
	paths   *childenv.Paths
}

func NewManager(paths *childenv.Paths) *Manager {
	return &Manager{daemons: make(map[string]*daemon), paths: paths}
}

// requestedIdentity returns the process identity opts describes.
func (opts StartOptions) requestedIdentity() identity.Options {
	return identity.Options{Uid: opts.Uid, Gid: opts.Gid, Groups: opts.Groups}
}

func (m *Manager) Start(name string, argv []string, cwd string, env map[string]string, opts StartOptions) (string, error) {
	if len(argv) == 0 || argv[0] == "" {
		return "", fmt.Errorf("argv must contain a command")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !namePattern.MatchString(name) {
		return "", fmt.Errorf("%w %q", ErrInvalidName, name)
	}
	if existing, ok := m.daemons[name]; ok && existing.info.Running {
		return "", ErrAlreadyRunning
	}
	// Bound the tracked set: make room by forgetting stopped daemons first.
	if len(m.daemons) >= maxDaemons {
		m.evictStoppedLocked()
	}
	if len(m.daemons) >= maxDaemons {
		return "", ErrTooMany
	}
	envCopy := make(map[string]string, len(env))
	for key, value := range env {
		envCopy[key] = value
	}
	cmd := exec.CommandContext(context.Background(), argv[0], argv[1:]...)
	cmd.Dir = cwd
	if opts.IsolatedEnv {
		cmd.Env = childenv.BuildIsolated(m.paths, envCopy)
	} else {
		cmd.Env = childenv.Build(m.paths, envCopy)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	requested := opts.requestedIdentity()
	if cred := identity.Credential(requested); cred != nil {
		cmd.SysProcAttr.Credential = cred
	}
	registered := &daemon{
		info: Daemon{
			Name:      name,
			Argv:      append([]string(nil), argv...),
			Running:   true,
			StartedAt: time.Now().UTC().Format(time.RFC3339),
			Uid:       requested.EffectiveUid(),
			Gid:       requested.EffectiveGid(),
			Groups:    append([]uint32(nil), opts.Groups...),
		},
		cmd:         cmd,
		cwd:         cwd,
		env:         envCopy,
		isolatedEnv: opts.IsolatedEnv,
		uid:         opts.Uid,
		gid:         opts.Gid,
		groups:      append([]uint32(nil), opts.Groups...),
		stdout:      newRing(ringCapacity),
		stderr:      newRing(ringCapacity),
	}
	cmd.Stdout = registered.stdout
	cmd.Stderr = registered.stderr
	if err := cmd.Start(); err != nil {
		return "", err
	}
	m.daemons[name] = registered
	go m.wait(registered)
	return name, nil
}

func (m *Manager) wait(d *daemon) {
	waitErr := d.cmd.Wait()
	exitCode := int32(0)
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = int32(exitErr.ExitCode())
		} else {
			exitCode = 1
		}
	}
	m.mu.Lock()
	d.info.Running = false
	d.info.ExitCode = exitCode
	d.info.StoppedAt = time.Now().UTC().Format(time.RFC3339)
	m.mu.Unlock()
}

// evictStoppedLocked forgets stopped daemons, oldest first, until the map is
// below its cap. It is called with m.mu held and never evicts a running one.
func (m *Manager) evictStoppedLocked() {
	stopped := make([]*daemon, 0, len(m.daemons))
	for _, d := range m.daemons {
		if !d.info.Running {
			stopped = append(stopped, d)
		}
	}
	sort.Slice(stopped, func(i, j int) bool {
		return stopped[i].info.StoppedAt < stopped[j].info.StoppedAt
	})
	for _, d := range stopped {
		if len(m.daemons) < maxDaemons {
			return
		}
		delete(m.daemons, d.info.Name)
	}
}

// List returns a stable snapshot of all tracked daemons sorted by name.
func (m *Manager) List() []Daemon {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]Daemon, 0, len(m.daemons))
	for _, d := range m.daemons {
		info := d.info
		info.Groups = append([]uint32(nil), d.info.Groups...)
		result = append(result, info)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

// Stop signals the daemon's process group and waits up to a grace period for
// it to exit, escalating to SIGKILL if needed. It is a no-op for a daemon that
// is not running.
func (m *Manager) Stop(name string, sig os.Signal) error {
	m.mu.Lock()
	d, ok := m.daemons[name]
	if !ok {
		m.mu.Unlock()
		return ErrUnknown
	}
	if !d.info.Running {
		m.mu.Unlock()
		return nil
	}
	cmd := d.cmd
	m.mu.Unlock()

	if sigNum, ok := sig.(syscall.Signal); ok {
		if err := syscall.Kill(-cmd.Process.Pid, sigNum); err != nil {
			_ = cmd.Process.Signal(sig)
		}
	} else {
		_ = cmd.Process.Signal(sig)
	}
	if m.waitForStop(d, stopGrace) {
		return nil
	}
	if _, ok := sig.(syscall.Signal); ok {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	_ = cmd.Process.Kill()
	m.waitForStop(d, stopGrace)
	return nil
}

func (m *Manager) waitForStop(d *daemon, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		running := d.info.Running
		m.mu.Unlock()
		if !running {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

// StopAll stops every running daemon with the given signal, concurrently, and
// returns the names of the daemons that were running.
func (m *Manager) StopAll(sig os.Signal) []string {
	m.mu.Lock()
	names := make([]string, 0, len(m.daemons))
	for name, d := range m.daemons {
		if d.info.Running {
			names = append(names, name)
		}
	}
	m.mu.Unlock()
	sort.Strings(names)
	var wg sync.WaitGroup
	for _, name := range names {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			_ = m.Stop(name, sig)
		}(name)
	}
	wg.Wait()
	return names
}

// Restart stops the daemon if it is running and starts it again with the same
// argv, working directory, environment, and process identity.
func (m *Manager) Restart(name string) error {
	m.mu.Lock()
	d, ok := m.daemons[name]
	if !ok {
		m.mu.Unlock()
		return ErrUnknown
	}
	argv := append([]string(nil), d.info.Argv...)
	cwd := d.cwd
	env := d.env
	isolatedEnv := d.isolatedEnv
	uid := d.uid
	gid := d.gid
	groups := append([]uint32(nil), d.groups...)
	running := d.info.Running
	m.mu.Unlock()
	if running {
		if err := m.Stop(name, syscall.SIGTERM); err != nil {
			return err
		}
	}
	_, err := m.Start(name, argv, cwd, env, StartOptions{Uid: uid, Gid: gid, Groups: groups, IsolatedEnv: isolatedEnv})
	return err
}

// Logs returns the tail of the daemon's captured stdout and stderr. A
// tailBytes <= 0 returns the whole buffer.
func (m *Manager) Logs(name string, tailBytes int) ([]byte, []byte, error) {
	m.mu.Lock()
	d, ok := m.daemons[name]
	m.mu.Unlock()
	if !ok {
		return nil, nil, ErrUnknown
	}
	return d.stdout.Tail(tailBytes), d.stderr.Tail(tailBytes), nil
}
