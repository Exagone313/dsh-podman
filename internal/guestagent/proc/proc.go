// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package proc inspects the Linux process table to answer terminal-readiness
// questions: which process group owns the foreground of a PTY, and whether a
// member of a process group is blocked reading the terminal's stdin.
package proc

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// procRoot is the mount point of the process table. It is a variable so tests
// can point the scanner at a fabricated tree.
var procRoot = "/proc"

// syscallArch is the kernel ABI the syscall numbers in /proc are read against.
// It mirrors runtime.GOARCH but is overridable in tests.
var syscallArch = runtime.GOARCH

// Filesystem seams, replaced in tests when a fabricated tree cannot express an
// operation (reading /proc/<pid>/mem, stat'ing a character device).
var (
	readFile = os.ReadFile
	readDir  = os.ReadDir
	readLink = os.Readlink
	statRdev = defaultStatRdev
	readMem  = defaultReadMem
)

// fileStatus is the part of a stat result the terminal scan needs.
type fileStatus struct {
	rdev   uint64
	isChar bool
}

func defaultStatRdev(path string) (uint64, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, false, err
	}
	rdev := uint64(0)
	if sys, ok := info.Sys().(*syscall.Stat_t); ok {
		rdev = uint64(uint32(sys.Rdev))
	}
	return rdev, info.Mode()&os.ModeCharDevice != 0, nil
}

func defaultReadMem(pid int, address uint64, length int) ([]byte, error) {
	file, err := os.Open(filepath.Join(procRoot, strconv.Itoa(pid), "mem"))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	buffer := make([]byte, length)
	n, err := file.ReadAt(buffer, int64(address))
	if n == 0 && err != nil {
		return nil, err
	}
	return buffer[:n], nil
}

type procStat struct {
	pid       int
	pgrp      int
	session   int
	state     string
	ttyDevice uint64
	tpgid     int
}

// parseProcStat reads the fields used from a /proc/<pid>/stat line, tolerating
// parentheses in the comm text.
func parseProcStat(text string) (procStat, bool) {
	open := strings.IndexByte(text, '(')
	close := strings.LastIndexByte(text, ')')
	if open <= 0 || close <= open {
		return procStat{}, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(text[:open]))
	if err != nil {
		return procStat{}, false
	}
	fields := strings.Fields(strings.TrimSpace(text[close+1:]))
	if len(fields) < 6 || len(fields[0]) != 1 {
		return procStat{}, false
	}
	_, err1 := strconv.Atoi(fields[1])
	pgrp, err2 := strconv.Atoi(fields[2])
	session, err3 := strconv.Atoi(fields[3])
	ttyRaw, err4 := strconv.ParseInt(fields[4], 10, 64)
	tpgid, err5 := strconv.Atoi(fields[5])
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil {
		return procStat{}, false
	}
	return procStat{
		pid:       pid,
		pgrp:      pgrp,
		session:   session,
		state:     fields[0],
		ttyDevice: uint64(uint32(ttyRaw)),
		tpgid:     tpgid,
	}, true
}

func readStat(pid int) (procStat, bool) {
	data, err := readFile(filepath.Join(procRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return procStat{}, false
	}
	return parseProcStat(string(data))
}

// ForegroundPgid returns the terminal process group of pid from
// /proc/<pid>/stat. The second result is false when the field is absent or not
// positive, meaning no foreground group is attached.
func ForegroundPgid(pid int) (int, bool) {
	stat, ok := readStat(pid)
	if !ok || stat.tpgid <= 0 {
		return 0, false
	}
	return stat.tpgid, true
}

// readLinuxTerminalDevice resolves the terminal a thread's stdin refers to. It
// returns the device number of the process's tty when the thread reads
// /dev/tty, or the character device behind the fd otherwise. A tid of zero
// reads the process's own fd/0.
func readLinuxTerminalDevice(pid int, ttyDevice uint64, tid int) (uint64, bool) {
	if ttyDevice == 0 {
		return 0, false
	}
	path := filepath.Join(procRoot, strconv.Itoa(pid), "fd", "0")
	if tid > 0 {
		path = filepath.Join(procRoot, strconv.Itoa(pid), "task", strconv.Itoa(tid), "fd", "0")
	}
	target, err := readLink(path)
	if err != nil {
		return 0, false
	}
	if target == "/dev/tty" {
		return ttyDevice, true
	}
	rdev, isChar, err := statRdev(path)
	if err != nil {
		return 0, false
	}
	if isChar && rdev == ttyDevice {
		return ttyDevice, true
	}
	return 0, false
}

// IsStdinWaiting reports whether a member of pgid is blocked reading the
// terminal owned by shellPid. It walks the process table and inspects each
// thread's blocked syscall.
func IsStdinWaiting(pgid, shellPid int) bool {
	tables := linuxSyscallTables(syscallArch)
	if len(tables) == 0 {
		return false
	}
	shell, ok := readStat(shellPid)
	if !ok {
		return false
	}
	terminalDevice, ok := readLinuxTerminalDevice(shellPid, shell.ttyDevice, 0)
	if !ok {
		return false
	}
	for _, pid := range numericEntries(procRoot) {
		process, ok := readStat(pid)
		if !ok || process.pgrp != pgid {
			continue
		}
		for _, tid := range numericEntries(filepath.Join(procRoot, strconv.Itoa(pid), "task")) {
			syscallInfo, ok := readSyscall(pid, tid)
			if !ok || !syscallWaitsOnStdin(pid, tid, syscallInfo, tables) {
				continue
			}
			device, ok := readLinuxTerminalDevice(pid, process.ttyDevice, tid)
			if ok && device == terminalDevice {
				return true
			}
		}
	}
	return false
}

func numericEntries(path string) []int {
	entries, err := readDir(path)
	if err != nil {
		return nil
	}
	result := make([]int, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !isNumeric(name) {
			continue
		}
		value, err := strconv.Atoi(name)
		if err != nil {
			continue
		}
		result = append(result, value)
	}
	return result
}

func isNumeric(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

type syscallInfo struct {
	number int
	args   []uint64
}

func readSyscall(pid, tid int) (syscallInfo, bool) {
	data, err := readFile(filepath.Join(procRoot, strconv.Itoa(pid), "task", strconv.Itoa(tid), "syscall"))
	if err != nil {
		return syscallInfo{}, false
	}
	text := strings.TrimSpace(string(data))
	if text == "running" || strings.HasPrefix(text, "-1 ") {
		return syscallInfo{}, false
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return syscallInfo{}, false
	}
	number, err := strconv.Atoi(fields[0])
	if err != nil {
		return syscallInfo{}, false
	}
	args := make([]uint64, 0, 6)
	for _, field := range fields[1:] {
		if len(args) == 6 {
			break
		}
		value, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimPrefix(field, "0x"), "0X"), 16, 64)
		if err != nil {
			return syscallInfo{}, false
		}
		args = append(args, value)
	}
	return syscallInfo{number: number, args: args}, true
}

func fdSetHasStdin(pid int, address uint64) bool {
	if address == 0 {
		return false
	}
	data, err := readMem(pid, address, 8)
	if err != nil || len(data) == 0 {
		return false
	}
	return data[0]%2 == 1
}

func pollHasStdin(pid int, address, count uint64) bool {
	if address == 0 || count == 0 {
		return false
	}
	if count > 1024 {
		count = 1024
	}
	data, err := readMem(pid, address, int(count)*8)
	if err != nil {
		return false
	}
	for offset := 0; offset+8 <= len(data); offset += 8 {
		fd := int32(binary.LittleEndian.Uint32(data[offset:]))
		events := int16(binary.LittleEndian.Uint16(data[offset+4:]))
		if fd == 0 && events&0x001 != 0 {
			return true
		}
	}
	return false
}

var epollStdinLine = regexp.MustCompile(`^tfd:\s+0\b`)

func epollHasStdin(pid, tid int, epfd uint64) bool {
	path := filepath.Join(procRoot, strconv.Itoa(pid), "task", strconv.Itoa(tid), "fdinfo", strconv.FormatUint(epfd, 10))
	data, err := readFile(path)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if epollStdinLine.MatchString(strings.TrimSpace(line)) {
			return true
		}
	}
	return false
}

type syscallTable struct {
	read       int
	selectNum  int
	pselect    int
	poll       int
	ppoll      int
	epollWait  int
	epollPwait int
}

// syscallTables holds the kernel ABI numbers for the architectures the guest
// agent runs on. A negative number means the syscall does not exist there.
var syscallTables = map[string]syscallTable{
	"amd64": {read: 0, selectNum: 23, pselect: 270, poll: 7, ppoll: 271, epollWait: 232, epollPwait: 281},
	"arm64": {read: 63, selectNum: -1, pselect: 72, poll: -1, ppoll: 73, epollWait: -1, epollPwait: 22},
}

// linuxSyscallTables returns the running architecture's table first, then the
// other, so user-mode emulation exposing a different ABI still resolves.
func linuxSyscallTables(arch string) []syscallTable {
	primary, ok := syscallTables[arch]
	if !ok {
		return nil
	}
	tables := []syscallTable{primary}
	for _, name := range []string{"amd64", "arm64"} {
		if name == arch {
			continue
		}
		tables = append(tables, syscallTables[name])
	}
	return tables
}

func syscallWaitsOnStdin(pid, tid int, info syscallInfo, tables []syscallTable) bool {
	var a0, a1, a2 uint64
	if len(info.args) > 0 {
		a0 = info.args[0]
	}
	if len(info.args) > 1 {
		a1 = info.args[1]
	}
	if len(info.args) > 2 {
		a2 = info.args[2]
	}
	for _, table := range tables {
		switch {
		case info.number == table.read:
			return a0 == 0
		case table.selectNum >= 0 && info.number == table.selectNum:
			return a0 >= 1 && fdSetHasStdin(pid, a1)
		case info.number == table.pselect:
			return a0 >= 1 && fdSetHasStdin(pid, a1)
		case table.poll >= 0 && info.number == table.poll:
			return a1 >= 1 && pollHasStdin(pid, a0, a1)
		case info.number == table.ppoll:
			return a1 >= 1 && pollHasStdin(pid, a0, a1)
		case table.epollWait >= 0 && info.number == table.epollWait:
			return a2 >= 1 && epollHasStdin(pid, tid, a0)
		case info.number == table.epollPwait:
			return a2 >= 1 && epollHasStdin(pid, tid, a0)
		}
	}
	return false
}
