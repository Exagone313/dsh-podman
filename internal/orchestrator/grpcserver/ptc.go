// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"path/filepath"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ptcPodmanName is the one fixed podman name of the shared PTC container. The
// container is not bound to a workspace, so it neither joins a workspace pod
// nor derives its name from a slug. Guest container names always carry a
// workspace slug (dsh-podman-<slug>-<logical>), so this name cannot collide.
const ptcPodmanName = containerNamePrefix + ptcContainerLogical

// ptcCreateError wraps a failure to make the shared PTC container usable in one
// actionable message: the PTC container is an orchestrator-managed
// prerequisite, not something the caller can repair by addressing it directly.
func ptcCreateError(err error) error {
	return status.Error(codes.Internal, fmt.Sprintf("cannot create the PTC container: %v", err))
}

// ensurePTCContainer makes the one shared PTC container usable and returns its
// record. The container is created lazily on first use, reused while it runs
// with the stored credential and the current PTC image, and recreated when it
// is missing, stopped, carries an outdated agent, or was built from an image
// with another release or recipe. It is a singleton: the record lives outside
// workspace state, so every caller shares one container.
func (s *Server) ensurePTCContainer(dshVersion string) (state.Container, error) {
	spec, err := imagebuild.PTCBuildSpec(dshVersion)
	if err != nil {
		return state.Container{}, status.Error(codes.InvalidArgument, err.Error())
	}
	imageID := spec.ImageID
	imageFingerprint := imagebuild.LabelFingerprint(spec.Labels)
	if s.Podman == nil {
		return state.Container{}, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	// Serialize on the fixed name so two concurrent first uses cannot both
	// create the shared container, and re-read its record under the lock.
	unlock := s.lockContainer(ptcPodmanName)
	defer unlock()
	record, found, err := s.Store.PTCContainer()
	if err != nil {
		return state.Container{}, status.Error(codes.Internal, err.Error())
	}
	if found {
		// The slot is the shared PTC container by definition, whatever a
		// record written by an older layout says.
		record.Name = ptcContainerLogical
		record.Kind = state.ContainerKindPTC
		record.PodmanName = ptcPodmanName
		usable, usableErr := s.containerUsable(&record)
		if usableErr != nil {
			return state.Container{}, ptcCreateError(usableErr)
		}
		// A container built from another image carries another PTC runtime or
		// recipe, so it is recreated even while it still runs. The tag is
		// fixed, so the image fingerprint, not its name, makes that decision.
		if usable && record.ImageID == imageID && record.ImageFingerprint == imageFingerprint {
			if record.Kind != state.ContainerKindPTC {
				// Heal a record written before the kind marker existed, so the
				// plugin recognizes the container from the snapshot.
				record.Kind = state.ContainerKindPTC
				if _, updateErr := s.upsertContainer(state.Workspace{}, record); updateErr != nil {
					return state.Container{}, status.Error(codes.Internal, updateErr.Error())
				}
				return record, nil
			}
			return record, nil
		}
	}
	imageTag, err := s.ensurePTCImage(dshVersion)
	if err != nil {
		return state.Container{}, err
	}
	if !found {
		record = state.Container{
			Name:             ptcContainerLogical,
			Kind:             state.ContainerKindPTC,
			PodmanName:       ptcPodmanName,
			ImageID:          imageID,
			ImageFingerprint: imageFingerprint,
		}
	}
	// A recreate keeps the token stable, exactly like a guest container's, so
	// a client that cached it still works after the PTC container comes back.
	secret, err := s.ensureAgentToken(&record)
	if err != nil {
		return state.Container{}, status.Error(codes.Internal, err.Error())
	}
	exists, err := s.Podman.ContainerExists(ptcPodmanName)
	if err != nil {
		return state.Container{}, ptcCreateError(err)
	}
	if exists {
		// A stopped container may refuse the stop; the forced removal below
		// still retires it, so a stop failure is logged rather than fatal.
		if err := s.Podman.Stop(ptcPodmanName); err != nil {
			s.log().Warn("PTC container stop failed", "podman_name", ptcPodmanName, "error", err)
		}
		if err := s.Podman.Remove(ptcPodmanName); err != nil {
			return state.Container{}, ptcCreateError(err)
		}
	}
	if err := s.Podman.CreatePTC(ptcPodmanName, imageTag, secret); err != nil {
		return state.Container{}, ptcCreateError(err)
	}
	if err := s.confirmContainerExists(ptcPodmanName); err != nil {
		return state.Container{}, ptcCreateError(err)
	}
	record.ImageFingerprint = imageFingerprint
	record.Kind = state.ContainerKindPTC
	s.markRecreated(&record, imageID)
	record.AgentToken = secret
	record.AgentSocketPath = filepath.Join(s.SocketsRoot, ptcPodmanName, "guest.sock")
	if _, err := s.upsertContainer(state.Workspace{}, record); err != nil {
		return state.Container{}, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("PTC container ready", "podman_name", ptcPodmanName, "dsh_version", dshVersion, "image_tag", imageTag)
	return record, nil
}

// ensurePTCImage returns the tag of the single PTC image, building it only when
// it is missing or carries labels other than the requested release and current
// recipe. Rebuilding replaces the tag, so the image never accumulates.
func (s *Server) ensurePTCImage(dshVersion string) (string, error) {
	builder, err := s.ptcImageBuilder()
	if err != nil {
		return "", err
	}
	tag := builder.PTCImageTag()
	labels, err := imagebuild.PTCImageLabels(dshVersion)
	if err != nil {
		return "", status.Error(codes.InvalidArgument, err.Error())
	}
	exists, err := s.Podman.ImageExists(tag)
	if err != nil {
		return "", status.Error(codes.Internal, fmt.Sprintf("cannot inspect the PTC image: %v", err))
	}
	if exists {
		actual, labelErr := s.Podman.ImageLabels(tag)
		if labelErr != nil {
			return "", status.Error(codes.Internal, fmt.Sprintf("cannot inspect the PTC image: %v", labelErr))
		}
		if ptcImageLabelsMatch(actual, labels) {
			s.log().Info("reusing PTC image", "dsh_version", dshVersion, "image_tag", tag)
			return tag, nil
		}
		s.log().Info("rebuilding stale PTC image", "dsh_version", dshVersion, "image_tag", tag)
	}
	built, err := builder.BuildPTC(dshVersion)
	if err != nil {
		return "", status.Error(codes.Internal, fmt.Sprintf("cannot build the PTC image with dsh version %q: %v", dshVersion, err))
	}
	s.log().Info("built PTC image", "dsh_version", dshVersion, "image_tag", built)
	return built, nil
}

// ptcImageLabelsMatch reports whether an image carries every label the current
// PTC recipe requires. A missing label is a mismatch; extra labels are
// harmless.
func ptcImageLabelsMatch(actual, expected map[string]string) bool {
	if len(expected) == 0 {
		return false
	}
	for key, want := range expected {
		if actual[key] != want {
			return false
		}
	}
	return true
}

// removePTCContainer retires the shared PTC container and forgets its record.
// It is the explicit workspace-less remove that replaces the former implicit
// teardown on workspace removal. It is idempotent: an absent record or podman
// container succeeds.
func (s *Server) removePTCContainer(ctx context.Context) error {
	if s.Podman == nil {
		return status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	unlock := s.lockContainer(ptcPodmanName)
	defer unlock()
	record, found, err := s.Store.PTCContainer()
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	if found {
		// The PTC container has no mounts, secrets, or ports, but the calls
		// stay best-effort and symmetric with a guest container's removal.
		s.releasePublishedPorts(ctx, record)
		s.stopContainerDaemons(ctx, record)
	}
	exists, err := s.Podman.ContainerExists(ptcPodmanName)
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	if exists {
		if err := s.Podman.Stop(ptcPodmanName); err != nil {
			s.log().Warn("PTC container stop failed", "podman_name", ptcPodmanName, "error", err)
		}
		if err := s.Podman.Remove(ptcPodmanName); err != nil {
			s.log().Error("PTC container removal failed", "podman_name", ptcPodmanName, "error", err)
			return status.Error(codes.Internal, err.Error())
		}
	}
	s.removeSocketDir(ptcPodmanName)
	if err := s.Store.RemovePTCContainer(); err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	s.log().Info("PTC container removed", "podman_name", ptcPodmanName)
	return nil
}

// ReconcilePTCContainers aligns the one shared PTC record with podman. It is
// best-effort and runs once at orchestrator start: a record whose container is
// gone is dropped (the next use recreates it lazily), and a surviving record's
// status is refreshed. Guest records and workspaces are untouched.
func (s *Server) ReconcilePTCContainers() {
	if s.Podman == nil {
		return
	}
	record, found, err := s.Store.PTCContainer()
	if err != nil {
		s.log().Warn("PTC reconcile state read failed", "error", err)
		return
	}
	if !found {
		return
	}
	exists, lookupErr := s.Podman.ContainerExists(record.PodmanName)
	if lookupErr != nil {
		s.log().Warn("PTC reconcile container lookup failed", "podman_name", record.PodmanName, "error", lookupErr)
		return
	}
	if !exists {
		s.log().Info("PTC container deleted outside dsh-podman", "podman_name", record.PodmanName)
		if err := s.Store.RemovePTCContainer(); err != nil {
			s.log().Warn("PTC reconcile state write failed", "error", err)
		}
		return
	}
	running, runErr := s.Podman.ContainerRunning(record.PodmanName)
	if runErr != nil {
		s.log().Warn("PTC reconcile inspect failed", "podman_name", record.PodmanName, "error", runErr)
		return
	}
	status := "stopped"
	if running {
		status = "running"
	}
	if err := s.Store.UpdatePTCContainer(func(current state.Container, found bool) (state.Container, error) {
		if !found {
			return current, nil
		}
		current.Status = status
		return current, nil
	}); err != nil {
		s.log().Warn("PTC reconcile state write failed", "error", err)
	}
}

// ptcContainerView returns the shared PTC record with its live run state
// refreshed in memory. It never writes, so listing stays a pure view. A
// container podman no longer holds is reported with its stored status rather
// than hidden: the shared row must stay visible even when no workspace exists.
func (s *Server) ptcContainerView(record state.Container) state.Container {
	record.Name = ptcContainerLogical
	record.Kind = state.ContainerKindPTC
	record.PodmanName = ptcPodmanName
	if s.Podman == nil {
		return record
	}
	exists, err := s.Podman.ContainerExists(record.PodmanName)
	if err != nil || !exists {
		return record
	}
	running, err := s.Podman.ContainerRunning(record.PodmanName)
	if err != nil {
		return record
	}
	if running {
		record.Status = "running"
	} else {
		record.Status = "stopped"
	}
	return record
}

// containerKindProto projects a stored container's kind onto the control
// plane's marker. An empty or unknown kind is an ordinary guest container.
func containerKindProto(kind string) ctl.ContainerKind {
	if kind == state.ContainerKindPTC {
		return ctl.ContainerKind_CONTAINER_KIND_PTC
	}
	return ctl.ContainerKind_CONTAINER_KIND_GUEST
}
