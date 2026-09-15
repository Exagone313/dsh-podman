// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package identity describes the process identity a caller may request for a
// child the guest agent starts: a numeric uid/gid and a complete supplementary
// group list.
package identity

import (
	"os"
	"os/exec"
	"syscall"
)

// Options is the requested identity. A nil Uid and Gid with no Groups means
// "no override": the child keeps the agent's own identity and supplementary
// groups, which is the container's default user.
type Options struct {
	Uid, Gid *uint32
	Groups   []uint32
}

// Credential builds the syscall credential for opts, or nil when no override
// was requested. When only Uid is set, Gid follows it; when only Gid is set,
// the uid stays 0. Groups is the child's complete supplementary set: fork/exec
// calls setgroups whenever a credential is present, so an empty list drops
// every supplementary group.
func Credential(opts Options) *syscall.Credential {
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

// EffectiveUid returns the uid a child runs as, 0 when no override was
// requested (the container's default user).
func (opts Options) EffectiveUid() uint32 {
	if opts.Uid != nil {
		return *opts.Uid
	}
	return 0
}

// EffectiveGid returns the gid a child runs as, 0 when no override was
// requested. It follows Uid when only Uid is set.
func (opts Options) EffectiveGid() uint32 {
	if opts.Gid != nil {
		return *opts.Gid
	}
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
