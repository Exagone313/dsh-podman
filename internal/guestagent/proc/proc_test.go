// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package proc

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

// fakeProc points the scanner at a fresh temporary tree for the duration of a
// test and restores the real /proc afterwards.
func fakeProc(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	previous := procRoot
	procRoot = root
	t.Cleanup(func() { procRoot = previous })
	return root
}

func writeTree(t *testing.T, root, relative, content string) {
	t.Helper()
	path := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func symlinkTree(t *testing.T, root, relative, target string) {
	t.Helper()
	path := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
}

func writeStat(t *testing.T, root string, pid int, state string, pgrp, session, ttyDevice, tpgid int) {
	t.Helper()
	content := fmt.Sprintf("%d (sh) %s %d %d %d %d %d 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
		pid, state, 1, pgrp, session, ttyDevice, tpgid)
	writeTree(t, root, filepath.Join(strconv.Itoa(pid), "stat"), content)
}

// readSyscallNumber returns the running architecture's read syscall number so
// the fabricated syscall files match the ABI the scanner uses.
func readSyscallNumber(t *testing.T) int {
	t.Helper()
	tables := linuxSyscallTables(runtime.GOARCH)
	if len(tables) == 0 {
		t.Skipf("no syscall table for %s", runtime.GOARCH)
	}
	return tables[0].read
}

func writeSyscall(t *testing.T, root string, pid, tid int, line string) {
	t.Helper()
	writeTree(t, root, filepath.Join(strconv.Itoa(pid), "task", strconv.Itoa(tid), "syscall"), line)
}

func syscallArgs(t *testing.T, line string) string {
	t.Helper()
	return line + " 0x0 0x0 0x0 0x0 0x0 0x0"
}

func TestForegroundPgid(t *testing.T) {
	root := fakeProc(t)
	writeStat(t, root, 100, "S", 100, 100, 34816, 42)
	if pgid, ok := ForegroundPgid(100); !ok || pgid != 42 {
		t.Fatalf("ForegroundPgid = (%d, %v), want (42, true)", pgid, ok)
	}
	writeStat(t, root, 101, "S", 101, 101, 0, 0)
	if pgid, ok := ForegroundPgid(101); ok || pgid != 0 {
		t.Fatalf("ForegroundPgid = (%d, %v), want (0, false)", pgid, ok)
	}
	if pgid, ok := ForegroundPgid(999); ok || pgid != 0 {
		t.Fatalf("ForegroundPgid(missing) = (%d, %v), want (0, false)", pgid, ok)
	}
}

func TestIsStdinWaitingReadSyscallMatchesShellTerminal(t *testing.T) {
	root := fakeProc(t)
	readNumber := readSyscallNumber(t)
	writeStat(t, root, 100, "S", 100, 100, 34816, 0)
	symlinkTree(t, root, filepath.Join("100", "fd", "0"), "/dev/tty")
	writeStat(t, root, 200, "S", 42, 42, 34816, 0)
	writeSyscall(t, root, 200, 201, syscallArgs(t, strconv.Itoa(readNumber)))
	symlinkTree(t, root, filepath.Join("200", "task", "201", "fd", "0"), "/dev/tty")
	if !IsStdinWaiting(42, 100) {
		t.Fatal("expected a matching stdin read to be detected")
	}
}

func TestIsStdinWaitingMismatchedTerminal(t *testing.T) {
	root := fakeProc(t)
	readNumber := readSyscallNumber(t)
	writeStat(t, root, 100, "S", 100, 100, 34816, 0)
	symlinkTree(t, root, filepath.Join("100", "fd", "0"), "/dev/tty")
	writeStat(t, root, 200, "S", 42, 42, 9999, 0)
	writeSyscall(t, root, 200, 201, syscallArgs(t, strconv.Itoa(readNumber)))
	symlinkTree(t, root, filepath.Join("200", "task", "201", "fd", "0"), "/dev/tty")
	if IsStdinWaiting(42, 100) {
		t.Fatal("expected a different terminal device not to match")
	}
}

func TestIsStdinWaitingDifferentProcessGroup(t *testing.T) {
	root := fakeProc(t)
	readNumber := readSyscallNumber(t)
	writeStat(t, root, 100, "S", 100, 100, 34816, 0)
	symlinkTree(t, root, filepath.Join("100", "fd", "0"), "/dev/tty")
	writeStat(t, root, 200, "S", 43, 43, 34816, 0)
	writeSyscall(t, root, 200, 201, syscallArgs(t, strconv.Itoa(readNumber)))
	symlinkTree(t, root, filepath.Join("200", "task", "201", "fd", "0"), "/dev/tty")
	if IsStdinWaiting(42, 100) {
		t.Fatal("expected a different process group to be ignored")
	}
}

func TestIsStdinWaitingSkipsNonWaitingSyscalls(t *testing.T) {
	root := fakeProc(t)
	readNumber := readSyscallNumber(t)
	writeStat(t, root, 100, "S", 100, 100, 34816, 0)
	symlinkTree(t, root, filepath.Join("100", "fd", "0"), "/dev/tty")
	writeStat(t, root, 200, "S", 42, 42, 34816, 0)
	writeSyscall(t, root, 200, 201, "running")
	writeSyscall(t, root, 200, 202, "-1 0x0 0x0 0x0 0x0 0x0 0x0")
	writeSyscall(t, root, 200, 203, syscallArgs(t, strconv.Itoa(readNumber+1)))
	for _, tid := range []string{"201", "202", "203"} {
		symlinkTree(t, root, filepath.Join("200", "task", tid, "fd", "0"), "/dev/tty")
	}
	if IsStdinWaiting(42, 100) {
		t.Fatal("expected running, -1, and non-waiting syscalls to be ignored")
	}
}

func TestParseProcStatRejectsMalformed(t *testing.T) {
	for _, text := range []string{"", "not a stat line", "1 (comm) S"} {
		if _, ok := parseProcStat(text); ok {
			t.Fatalf("parseProcStat accepted %q", text)
		}
	}
}

func TestParseProcStatHandlesParenthesesInComm(t *testing.T) {
	line := "123 (weird ) name) S 1 42 42 34816 7 0 0 0 0 0 0 0 0 0 0 0 0 0 0"
	stat, ok := parseProcStat(line)
	if !ok {
		t.Fatal("parseProcStat rejected a comm with parentheses")
	}
	if stat.pid != 123 || stat.pgrp != 42 || stat.ttyDevice != 34816 || stat.tpgid != 7 {
		t.Fatalf("unexpected parsed stat: %#v", stat)
	}
}

func TestIsStdinWaitingWithoutTerminalDevice(t *testing.T) {
	root := fakeProc(t)
	writeStat(t, root, 100, "S", 100, 100, 0, 0)
	if IsStdinWaiting(42, 100) {
		t.Fatal("expected a shell without a terminal to report false")
	}
}

func TestSyscallTables(t *testing.T) {
	amd64 := linuxSyscallTables("amd64")
	if len(amd64) != 2 || amd64[0].read != 0 {
		t.Fatalf("amd64 tables = %#v, want read first with number 0", amd64)
	}
	arm64 := linuxSyscallTables("arm64")
	if len(arm64) != 2 || arm64[0].read != 63 {
		t.Fatalf("arm64 tables = %#v, want read first with number 63", arm64)
	}
	if linuxSyscallTables("riscv64") != nil {
		t.Fatal("expected an unsupported architecture to resolve no tables")
	}
}
