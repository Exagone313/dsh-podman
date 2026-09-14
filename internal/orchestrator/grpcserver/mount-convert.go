// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
)

// stateMounts projects the control plane's project mounts onto the state
// model's read_only/read_write representation, rejecting the whole list when
// any mount is malformed.
func stateMounts(mounts []*ctl.ProjectMount) ([]state.Mount, error) {
	result := make([]state.Mount, 0, len(mounts))
	for _, mount := range mounts {
		converted, err := mountFromProto(mount)
		if err != nil {
			return nil, err
		}
		result = append(result, converted)
	}
	return result, nil
}

// mountFromProto maps a control plane project mount onto its state
// representation.
//
// An unrecognised kind or mode is an error rather than a default. Protobuf
// keeps unknown enum numbers as-is on the wire, so coercing them would turn a
// value this build does not understand into a project mount, or an
// unspecified mode into a silent read_only, instead of telling the client.
// Secret mounts are the one kind that carries no mode.
func mountFromProto(mount *ctl.ProjectMount) (state.Mount, error) {
	kind, err := mountKindFromProto(mount.GetKind())
	if err != nil {
		return state.Mount{}, err
	}
	if kind == "secret" {
		return state.Mount{Kind: kind, Secret: mount.GetSecret(), Destination: mount.GetDestination()}, nil
	}
	mode, err := mountModeFromProto(mount.GetMode())
	if err != nil {
		return state.Mount{}, err
	}
	return state.Mount{ProjectName: mount.GetProjectName(), Destination: mount.GetDestination(), Mode: mode, Kind: kind, Volume: mount.GetVolume()}, nil
}

// mountKindFromProto maps a control plane mount kind onto the state's string
// representation ("", "tmpfs", or "volume"), rejecting unknown kinds.
func mountKindFromProto(kind ctl.MountKind) (string, error) {
	switch kind {
	case ctl.MountKind_MOUNT_KIND_UNSPECIFIED, ctl.MountKind_MOUNT_KIND_PROJECT:
		return "", nil
	case ctl.MountKind_MOUNT_KIND_TMPFS:
		return "tmpfs", nil
	case ctl.MountKind_MOUNT_KIND_VOLUME:
		return "volume", nil
	case ctl.MountKind_MOUNT_KIND_SECRET:
		return "secret", nil
	default:
		return "", fmt.Errorf("invalid mount kind %q", kind.String())
	}
}

// knownMountKind reports whether kind is a mount kind the server handles.
func knownMountKind(kind string) bool {
	switch kind {
	case "", "tmpfs", "volume", "secret":
		return true
	}
	return false
}

// mountKindToProto projects a state mount kind onto the control plane enum;
// the empty kind (legacy project mounts) maps to MOUNT_KIND_PROJECT.
func mountKindToProto(kind string) ctl.MountKind {
	switch kind {
	case "tmpfs":
		return ctl.MountKind_MOUNT_KIND_TMPFS
	case "volume":
		return ctl.MountKind_MOUNT_KIND_VOLUME
	case "secret":
		return ctl.MountKind_MOUNT_KIND_SECRET
	default:
		return ctl.MountKind_MOUNT_KIND_PROJECT
	}
}

// mountModeFromProto maps a control plane mount mode onto the state's
// read_only/read_write representation, rejecting unspecified modes.
func mountModeFromProto(mode ctl.MountMode) (string, error) {
	switch mode {
	case ctl.MountMode_MOUNT_MODE_READ_WRITE:
		return "read_write", nil
	case ctl.MountMode_MOUNT_MODE_READ_ONLY:
		return "read_only", nil
	default:
		return "", fmt.Errorf("invalid mount mode %q", mode.String())
	}
}
