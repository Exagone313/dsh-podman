// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package ptc shapes the children the guest agent starts inside the reserved
// PTC container.
//
// The PTC container's root filesystem is read-only and its agent runs as euid
// 0, so an inherited HOME (/root) is not writable. Every PTC child therefore
// runs as a numeric uid/gid, with HOME and the XDG directories pointing at a
// writable home owned by that uid. The agent keeps euid 0 and needs CAP_SETUID
// and CAP_SETGID to perform the switch, plus CAP_CHOWN and CAP_DAC_OVERRIDE to
// create and repair a home that another identity may already own.
package ptc

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/Exagone313/dsh-podman/internal/guestagent/identity"
)

// ModeEnv marks the guest agent's container as the reserved PTC container. It
// matches the orchestrator's PTCModeEnv.
const ModeEnv = "DSH_PODMAN_GUEST_PTC_MODE"

// DefaultUID and DefaultGID are the numeric identity a PTC child runs as when
// the caller requests no identity. They are deliberately not root and not a
// user the image defines.
const (
	DefaultUID uint32 = 65534
	DefaultGID uint32 = 65534
)

// homeRoot is the per-container parent of the PTC children's writable homes.
// It lives on the size-capped /tmp tmpfs the PTC container mounts, so it is
// writable on the otherwise read-only rootfs and cannot grow without bound.
const homeRoot = "/tmp/dsh-podman-home"

// Enabled reports whether this guest agent serves the reserved PTC container.
func Enabled() bool {
	value := os.Getenv(ModeEnv)
	return value == "1" || value == "true"
}

// Attach returns the identity and environment a PTC child must use. Outside
// PTC mode it is a no-op. In PTC mode it supplies the default numeric identity
// when the caller requested none, prepares a writable home owned by the
// resulting uid/gid, and adds HOME and the XDG variables to the child's
// environment (overriding the inherited /root).
func Attach(opts identity.Options, env map[string]string) (identity.Options, map[string]string, error) {
	if !Enabled() {
		return opts, env, nil
	}
	if opts.Uid == nil && opts.Gid == nil {
		uid, gid := DefaultUID, DefaultGID
		opts.Uid = &uid
		opts.Gid = &gid
	}
	home, err := prepareHome(opts.EffectiveUid(), opts.EffectiveGid())
	if err != nil {
		return opts, env, err
	}
	merged := make(map[string]string, len(env)+6)
	for key, value := range env {
		merged[key] = value
	}
	for key, value := range HomeEnv(home) {
		merged[key] = value
	}
	return opts, merged, nil
}

// HomeEnv returns the HOME and XDG variables pointing at home.
func HomeEnv(home string) map[string]string {
	return map[string]string{
		"HOME":            home,
		"XDG_CACHE_HOME":  filepath.Join(home, ".cache"),
		"XDG_CONFIG_HOME": filepath.Join(home, ".config"),
		"XDG_DATA_HOME":   filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME":  filepath.Join(home, ".local", "state"),
		"XDG_RUNTIME_DIR": filepath.Join(home, ".local", "run"),
	}
}

// prepareHome creates (or repairs) the writable home of uid/gid and returns its
// path. The returned directory and its XDG subdirectories are owned by that
// identity and private to it, so the child can write them. A directory that
// already exists is chowned and chmodded as needed, which keeps an arbitrary
// requested uid working even after an earlier run, or root, created it.
func prepareHome(uid, gid uint32) (string, error) {
	return prepareHomeAt(homeRoot, uid, gid)
}

// prepareHomeAt is prepareHome against an explicit parent directory, so the
// repair logic is testable without touching the deployment's real home root.
func prepareHomeAt(root string, uid, gid uint32) (string, error) {
	// The parent must be traversable (and writable, for creating a missing
	// home) by every PTC child uid, while each home below it stays private to
	// its own uid. The sticky bit keeps one uid from replacing another's home.
	const homeRootMode = os.FileMode(0o777) | os.ModeSticky
	if err := os.MkdirAll(root, homeRootMode); err != nil {
		return "", fmt.Errorf("create PTC home parent %q: %w", root, err)
	}
	if err := os.Chmod(root, homeRootMode); err != nil {
		return "", fmt.Errorf("open PTC home parent %q: %w", root, err)
	}
	home := filepath.Join(root, strconv.FormatUint(uint64(uid), 10))
	if err := repairHome(homeDirectories(home), uid, gid); err != nil {
		return "", fmt.Errorf("repair PTC home %q: %w", home, err)
	}
	return home, nil
}

// homeDirectories lists the directories a PTC child must traverse, parents
// first. Every one of them is created and owned here: owning only a leaf would
// leave an intermediate .local root-owned and untraversable for the child's
// uid.
func homeDirectories(home string) []string {
	return []string{
		home,
		filepath.Join(home, ".cache"),
		filepath.Join(home, ".config"),
		filepath.Join(home, ".local"),
		filepath.Join(home, ".local", "share"),
		filepath.Join(home, ".local", "state"),
		filepath.Join(home, ".local", "run"),
	}
}

// repairHome makes every directory exist, owned by uid/gid and private to it.
// The PTC container keeps CAP_CHOWN and CAP_DAC_OVERRIDE but neither CAP_FOWNER
// nor any other capability: it may take ownership of a directory it did not
// create and traverse a target-owned home, but chmod needs ownership, so a
// directory that is not the agent's is first chowned to the agent (uid 0).
func repairHome(directories []string, uid, gid uint32) error {
	for _, directory := range directories {
		info, err := os.Lstat(directory)
		if errors.Is(err, fs.ErrNotExist) {
			if err := os.Mkdir(directory, 0o700); err != nil {
				return fmt.Errorf("cannot create %q: %w", directory, err)
			}
			info, err = os.Lstat(directory)
		}
		if err != nil {
			return fmt.Errorf("cannot inspect %q: %w", directory, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("cannot repair %q: it is not a directory", directory)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("cannot inspect %q: no ownership data", directory)
		}
		if stat.Uid == uid && stat.Gid == gid && info.Mode().Perm() == 0o700 {
			continue
		}
		// chmod requires ownership (or CAP_FOWNER, which the PTC container does
		// not keep), so take the directory over before restricting it.
		if stat.Uid != 0 {
			if err := os.Chown(directory, 0, 0); err != nil {
				return fmt.Errorf("cannot take ownership of %q (owned by %d:%d): %w", directory, stat.Uid, stat.Gid, err)
			}
		}
		if info.Mode().Perm() != 0o700 {
			if err := os.Chmod(directory, 0o700); err != nil {
				return fmt.Errorf("cannot restrict %q to 0700: %w", directory, err)
			}
		}
		if err := os.Chown(directory, int(uid), int(gid)); err != nil {
			return fmt.Errorf("cannot give %q to %d:%d: %w", directory, uid, gid, err)
		}
	}
	return nil
}
