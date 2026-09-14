// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package terminal manages pseudo-terminal sessions for the guest agent. Each
// session runs one process on a fresh PTY and exposes its output, exit outcome,
// and foreground-process-group inspection.
package terminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/Exagone313/dsh-podman/internal/guestagent/childenv"
	"github.com/Exagone313/dsh-podman/internal/guestagent/proc"
	"github.com/creack/pty"
)

const stopGrace = 5 * time.Second

// Outcome is how a terminal process finished.
type Outcome struct {
	ExitCode int32
	Signaled bool
	Signal   string
}

// Session is one running PTY-backed process.
type Session struct {
	pid     int
	master  *os.File
	cmd     *exec.Cmd
	manager *Manager

	output    chan []byte
	done      chan Outcome
	finished  chan struct{}
	closed    chan struct{}
	closeOnce sync.Once

	mu      sync.Mutex
	outcome Outcome
}

// Pid returns the process identifier of the session leader.
func (s *Session) Pid() int { return s.pid }

// Output delivers PTY output in order. The channel is closed once the process
// exits and every buffered byte has been delivered.
func (s *Session) Output() <-chan []byte { return s.output }

// Done yields the process outcome and is then closed.
func (s *Session) Done() <-chan Outcome { return s.done }

// Write sends bytes to the PTY, which the foreground process reads as stdin.
func (s *Session) Write(data []byte) error {
	_, err := s.master.Write(data)
	return err
}

// Resize changes the PTY window size and notifies the foreground process.
func (s *Session) Resize(rows, cols uint16) error {
	return pty.Setsize(s.master, &pty.Winsize{Rows: rows, Cols: cols})
}

// SignalForeground signals the terminal's current foreground process group.
// It returns the group id and whether a signal was delivered; a signal name
// that is not recognised, or a terminal with no foreground group, reports
// false.
func (s *Session) SignalForeground(name string) (int, bool) {
	signal, ok := signalForName(name)
	if !ok {
		return 0, false
	}
	pgid, found := proc.ForegroundPgid(s.pid)
	if !found {
		return 0, false
	}
	_ = syscall.Kill(-pgid, signal)
	return pgid, true
}

// Inspect returns the foreground process group, whether a member of it is
// blocked reading the terminal's stdin, and whether a foreground group exists.
func (s *Session) Inspect() (int, bool, bool) {
	pgid, found := proc.ForegroundPgid(s.pid)
	if !found {
		return 0, false, false
	}
	return pgid, proc.IsStdinWaiting(pgid, s.pid), true
}

// Terminate asks the process group to stop with SIGTERM, escalates to SIGKILL
// after the grace period, and waits for the process to exit. The PTY master is
// then closed so a reader blocked on a lingering slave unblocks.
func (s *Session) Terminate(grace time.Duration) error {
	s.closeOnce.Do(func() { close(s.closed) })
	s.signalGroup(syscall.SIGTERM)
	if !s.waitForExit(grace) {
		s.signalGroup(syscall.SIGKILL)
		s.waitForExit(grace)
	}
	_ = s.master.Close()
	return nil
}

func (s *Session) signalGroup(signal syscall.Signal) {
	if s.cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-s.pid, signal); err != nil {
		_ = s.cmd.Process.Signal(signal)
	}
}

func (s *Session) waitForExit(grace time.Duration) bool {
	if grace <= 0 {
		grace = stopGrace
	}
	select {
	case <-s.finished:
		return true
	case <-time.After(grace):
		return false
	}
}

// Outcome returns the recorded result once the process has exited.
func (s *Session) Outcome() (Outcome, bool) {
	select {
	case <-s.finished:
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.outcome, true
	default:
		return Outcome{}, false
	}
}

// readLoop forwards PTY output until the master reports the slave is gone.
func (s *Session) readLoop() {
	defer close(s.output)
	buffer := make([]byte, 32*1024)
	for {
		n, err := s.master.Read(buffer)
		if n > 0 {
			chunk := append([]byte(nil), buffer[:n]...)
			select {
			case s.output <- chunk:
			case <-s.closed:
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// waitLoop records the outcome and releases the session once the process exits.
func (s *Session) waitLoop() {
	err := s.cmd.Wait()
	outcome := outcomeFromWait(err)
	s.mu.Lock()
	s.outcome = outcome
	s.mu.Unlock()
	s.manager.remove(s)
	s.done <- outcome
	close(s.done)
	close(s.finished)
}

func outcomeFromWait(err error) Outcome {
	if err == nil {
		return Outcome{}
	}
	outcome := Outcome{ExitCode: 1}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		outcome.ExitCode = int32(exitErr.ExitCode())
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			outcome.Signaled = true
			outcome.Signal = status.Signal().String()
		}
	}
	return outcome
}

// Manager tracks the live terminal sessions the agent has started.
type Manager struct {
	mu       sync.Mutex
	sessions map[int]*Session
	paths    *childenv.Paths
}

func NewManager(paths *childenv.Paths) *Manager {
	return &Manager{sessions: make(map[int]*Session), paths: paths}
}

// Start launches argv on a fresh PTY with the given working directory and
// environment, then registers the session.
func (m *Manager) Start(argv []string, cwd string, env map[string]string, rows, cols uint16) (*Session, error) {
	if len(argv) == 0 || argv[0] == "" {
		return nil, fmt.Errorf("argv must contain a command")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
	// Build already withholds the agent's reserved variables; TERM is added so
	// the child does not inherit a dumb or missing terminal type.
	cmd.Env = append(childenv.Build(m.paths, env), "TERM=xterm-256color")
	size := &pty.Winsize{Rows: rows, Cols: cols}
	if size.Rows == 0 {
		size.Rows = 24
	}
	if size.Cols == 0 {
		size.Cols = 80
	}
	master, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return nil, err
	}
	session := &Session{
		pid:      cmd.Process.Pid,
		master:   master,
		cmd:      cmd,
		manager:  m,
		output:   make(chan []byte, 32),
		done:     make(chan Outcome, 1),
		finished: make(chan struct{}),
		closed:   make(chan struct{}),
	}
	m.register(session)
	go session.readLoop()
	go session.waitLoop()
	return session, nil
}

func (m *Manager) register(session *Session) {
	m.mu.Lock()
	m.sessions[session.pid] = session
	m.mu.Unlock()
}

func (m *Manager) remove(session *Session) {
	m.mu.Lock()
	if m.sessions[session.pid] == session {
		delete(m.sessions, session.pid)
	}
	m.mu.Unlock()
}

// List returns a snapshot of the live sessions.
func (m *Manager) List() []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		result = append(result, session)
	}
	return result
}

// StopAll terminates every live session, signalling each with sig before
// escalating. It is safe to call concurrently with new sessions starting.
func (m *Manager) StopAll(sig os.Signal) {
	for _, session := range m.List() {
		session.closeOnce.Do(func() { close(session.closed) })
		if signal, ok := sig.(syscall.Signal); ok {
			session.signalGroup(signal)
		} else if session.cmd.Process != nil {
			_ = session.cmd.Process.Signal(sig)
		}
		if !session.waitForExit(stopGrace) {
			session.signalGroup(syscall.SIGKILL)
			session.waitForExit(stopGrace)
		}
		_ = session.master.Close()
	}
}

// Close stops every session with SIGTERM.
func (m *Manager) Close() { m.StopAll(syscall.SIGTERM) }

// terminalSignals maps the names callers may use onto the signal delivered.
var terminalSignals = map[string]syscall.Signal{
	"SIGHUP":   syscall.SIGHUP,
	"SIGINT":   syscall.SIGINT,
	"SIGQUIT":  syscall.SIGQUIT,
	"SIGKILL":  syscall.SIGKILL,
	"SIGTERM":  syscall.SIGTERM,
	"SIGUSR1":  syscall.SIGUSR1,
	"SIGUSR2":  syscall.SIGUSR2,
	"SIGTSTP":  syscall.SIGTSTP,
	"SIGCONT":  syscall.SIGCONT,
	"SIGWINCH": syscall.SIGWINCH,
}

// signalForName resolves a signal name. An empty name means SIGTERM, the
// default for asking a process to stop.
func signalForName(name string) (syscall.Signal, bool) {
	if name == "" {
		return syscall.SIGTERM, true
	}
	signal, ok := terminalSignals[name]
	return signal, ok
}
