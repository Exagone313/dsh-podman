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
)

var (
	ErrAlreadyRunning = errors.New("daemon already running")
	ErrUnknown        = errors.New("unknown daemon")
)

const (
	ringCapacity = 256 * 1024
	stopGrace    = 10 * time.Second
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
}

// StartOptions carries optional process identity settings. When neither Uid
// nor Gid is set (and no supplementary groups are requested), the process runs
// as the container's default user.
type StartOptions struct {
	Uid, Gid *uint32
	Groups   []uint32
}

type daemon struct {
	info   Daemon
	cmd    *exec.Cmd
	cwd    string
	env    map[string]string
	uid    *uint32
	gid    *uint32
	groups []uint32
	stdout *ring
	stderr *ring
}

// Manager tracks daemons spawned detached from any RPC request context.
type Manager struct {
	mu      sync.Mutex
	daemons map[string]*daemon
	next    uint64
}

func NewManager() *Manager { return &Manager{daemons: make(map[string]*daemon)} }

// credentialFor returns the process credential described by opts, or nil when
// no identity override was requested.
func credentialFor(opts StartOptions) *syscall.Credential {
	if opts.Uid == nil && opts.Gid == nil && len(opts.Groups) == 0 {
		return nil
	}
	cred := &syscall.Credential{}
	switch {
	case opts.Uid != nil && opts.Gid != nil:
		cred.Uid = *opts.Uid
		cred.Gid = *opts.Gid
	case opts.Uid != nil:
		cred.Uid = *opts.Uid
		cred.Gid = *opts.Uid
	case opts.Gid != nil:
		cred.Gid = *opts.Gid
	}
	if len(opts.Groups) > 0 {
		cred.Groups = opts.Groups
	}
	return cred
}

// effectiveUid returns the uid the daemon will run as given opts.
func effectiveUid(opts StartOptions) uint32 {
	if opts.Uid != nil {
		return *opts.Uid
	}
	return 0
}

// CanSwitchUser reports whether the current process can start commands as a
// different uid/gid. It requires root with the setuid/setgid capabilities,
// which sandboxes and some CI containers lack, so tests that exercise a real
// identity switch skip when it is unavailable.
func CanSwitchUser() bool {
	if os.Geteuid() != 0 {
		return false
	}
	cmd := exec.Command("true")
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1, Gid: 1}}
	return cmd.Run() == nil
}

func effectiveGid(opts StartOptions) uint32 {
	if opts.Gid != nil {
		return *opts.Gid
	}
	if opts.Uid != nil {
		return *opts.Uid
	}
	return 0
}

func (m *Manager) Start(name string, argv []string, cwd string, env map[string]string, opts StartOptions) (string, error) {
	if len(argv) == 0 || argv[0] == "" {
		return "", fmt.Errorf("argv must contain a command")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if name == "" {
		m.next++
		name = fmt.Sprintf("daemon-%d", m.next)
	} else if !namePattern.MatchString(name) {
		return "", fmt.Errorf("invalid daemon name %q", name)
	}
	if existing, ok := m.daemons[name]; ok && existing.info.Running {
		return "", ErrAlreadyRunning
	}
	envCopy := make(map[string]string, len(env))
	for key, value := range env {
		envCopy[key] = value
	}
	cmd := exec.CommandContext(context.Background(), argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = childenv.Build(envCopy)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if cred := credentialFor(opts); cred != nil {
		cmd.SysProcAttr.Credential = cred
	}
	registered := &daemon{
		info: Daemon{
			Name:      name,
			Argv:      append([]string(nil), argv...),
			Running:   true,
			StartedAt: time.Now().UTC().Format(time.RFC3339),
			Uid:       effectiveUid(opts),
			Gid:       effectiveGid(opts),
		},
		cmd:    cmd,
		cwd:    cwd,
		env:    envCopy,
		uid:    opts.Uid,
		gid:    opts.Gid,
		groups: append([]uint32(nil), opts.Groups...),
		stdout: newRing(ringCapacity),
		stderr: newRing(ringCapacity),
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

// List returns a stable snapshot of all tracked daemons sorted by name.
func (m *Manager) List() []Daemon {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]Daemon, 0, len(m.daemons))
	for _, d := range m.daemons {
		result = append(result, d.info)
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
	_, err := m.Start(name, argv, cwd, env, StartOptions{Uid: uid, Gid: gid, Groups: groups})
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
