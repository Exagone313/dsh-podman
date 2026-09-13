// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"go.podman.io/podman/v6/pkg/specgen"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// validateSecretReferences checks that every secret named by a container's
// environment bindings and secret mounts exists under the orchestrator prefix.
// It runs before any mutation so a missing secret fails with NOT_FOUND instead
// of surfacing podman's internal naming after the old container was removed.
func (s *Server) validateSecretReferences(secretEnv map[string]string, mounts []state.Mount) error {
	check := func(name string) error {
		exists, err := s.Podman.SecretExists(s.SecretPrefix + name)
		if err != nil {
			return status.Error(codes.Internal, err.Error())
		}
		if !exists {
			return status.Error(codes.NotFound, fmt.Sprintf("secret %q not found", name))
		}
		return nil
	}
	for _, name := range secretEnv {
		if err := check(name); err != nil {
			return err
		}
	}
	for _, mount := range mounts {
		if mount.Kind != "secret" {
			continue
		}
		if err := check(mount.Secret); err != nil {
			return err
		}
	}
	return nil
}

// secretInUse reports the first container that mounts the named secret as a
// file, or attaches it to its environment. The second return value is the
// prepositional phrase completing "secret %q is %s workspace %q container %q".
func secretInUse(workspaces []state.Workspace, name string) (slug, container, usage string, ok bool) {
	for _, ws := range workspaces {
		for _, c := range ws.Containers {
			for _, mount := range containerMounts(ws, c) {
				if mount.Kind == "secret" && mount.Secret == name {
					return ws.WorkspaceSlug, c.Name, "mounted in", true
				}
			}
			for _, secret := range c.SecretEnv {
				if secret == name {
					return ws.WorkspaceSlug, c.Name, "attached to the environment of", true
				}
			}
		}
	}
	return "", "", "", false
}

// podmanSecrets builds the secrets handed to podman from the stored mounts.
// Each secret mount must carry a valid short secret name and an absolute
// destination that never lands under ProjectsRoot.
func (s *Server) podmanSecrets(mounts []state.Mount) ([]specgen.Secret, error) {
	secrets := make([]specgen.Secret, 0, len(mounts))
	for _, mount := range mounts {
		if mount.Kind != "secret" {
			continue
		}
		if !secretName.MatchString(mount.Secret) {
			return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret name %q", mount.Secret))
		}
		if mount.Destination == "" {
			return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("secret %q mount needs a destination", mount.Secret))
		}
		if err := s.nonProjectDestination(mount.Destination); err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		secrets = append(secrets, specgen.Secret{Source: s.SecretPrefix + mount.Secret, Target: mount.Destination})
	}
	return secrets, nil
}

// containerEnvSecrets maps container secret env vars (env var name to short
// secret name) onto the podman environment secret form (env var name to the
// prefixed podman secret name).
func (s *Server) containerEnvSecrets(secretEnv map[string]string) map[string]string {
	if len(secretEnv) == 0 {
		return nil
	}
	result := make(map[string]string, len(secretEnv))
	for key, name := range secretEnv {
		result[key] = s.SecretPrefix + name
	}
	return result
}

// secretAlphabets are the character sets randomSecret may draw from.
var secretAlphabets = map[string]string{
	"alphanumeric": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
	"hex":          "0123456789abcdef",
	"base64url":    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
}

// randomSecret generates a random secret of exactly length bytes drawn from
// the given charset. A zero length defaults to 32; the empty charset defaults
// to "alphanumeric". Bytes are produced with rejection sampling per byte to
// keep the distribution uniform.
func randomSecret(length int, charset string) (string, error) {
	if length == 0 {
		length = 32
	}
	if length < 1 || length > 1024 {
		return "", fmt.Errorf("invalid secret length %d", length)
	}
	if charset == "" {
		charset = "alphanumeric"
	}
	alphabet, ok := secretAlphabets[charset]
	if !ok {
		return "", fmt.Errorf("invalid secret charset %q", charset)
	}
	result := make([]byte, length)
	modulus := len(alphabet)
	limit := 256 - 256%modulus
	buf := make([]byte, 1)
	for i := range result {
		for {
			if _, err := rand.Read(buf); err != nil {
				return "", fmt.Errorf("generate secret: %w", err)
			}
			if b := int(buf[0]); b < limit {
				result[i] = alphabet[b%modulus]
				break
			}
		}
	}
	return string(result), nil
}

// ListSecrets lists the orchestrator-managed secrets, exposing only their
// unprefixed short names. Secret values are never exposed to clients.
func (s *Server) ListSecrets(_ context.Context, _ *ctl.ListSecretsRequest) (*ctl.ListSecretsResponse, error) {
	s.log().Info("control request", "method", "ListSecrets")
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	names, err := s.Podman.SecretList()
	if err != nil {
		s.log().Error("control request failed", "method", "ListSecrets", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListSecretsResponse{}
	for _, name := range names {
		if !strings.HasPrefix(name, s.SecretPrefix) {
			continue
		}
		result.Secrets = append(result.Secrets, &ctl.Secret{Name: name[len(s.SecretPrefix):]})
	}
	s.log().Info("control request completed", "method", "ListSecrets", "count", len(result.Secrets))
	return result, nil
}

// CreateSecret generates a random secret value and stores it under the
// orchestrator's prefix. The generated value is never logged and never
// returned to the client.
func (s *Server) CreateSecret(_ context.Context, request *ctl.CreateSecretRequest) (*ctl.Secret, error) {
	s.log().Info("control request", "method", "CreateSecret", "name", request.GetName(), "length", request.GetLength(), "charset", request.GetCharset())
	if !secretName.MatchString(request.GetName()) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret name %q", request.GetName()))
	}
	if length := int(request.GetLength()); length != 0 && (length < 1 || length > 1024) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret length %d", length))
	}
	switch request.GetCharset() {
	case "", "alphanumeric", "hex", "base64url":
	default:
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret charset %q", request.GetCharset()))
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	full := s.SecretPrefix + request.GetName()
	exists, err := s.Podman.SecretExists(full)
	if err != nil {
		s.log().Error("control request failed", "method", "CreateSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if exists {
		return nil, status.Error(codes.AlreadyExists, fmt.Sprintf("secret %q already exists", request.GetName()))
	}
	value, err := randomSecret(int(request.GetLength()), request.GetCharset())
	if err != nil {
		s.log().Error("control request failed", "method", "CreateSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.Podman.SecretCreate(full, value); err != nil {
		s.log().Error("control request failed", "method", "CreateSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "CreateSecret", "name", request.GetName())
	return &ctl.Secret{Name: request.GetName()}, nil
}

// WriteSecretValue overwrites a secret's value with a client-supplied one
// (used by the UI to write generated values). The value is never logged.
func (s *Server) WriteSecretValue(_ context.Context, request *ctl.WriteSecretValueRequest) (*ctl.Secret, error) {
	s.log().Info("control request", "method", "WriteSecretValue", "name", request.GetName())
	if !secretName.MatchString(request.GetName()) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret name %q", request.GetName()))
	}
	if request.GetValue() == "" || strings.ContainsRune(request.GetValue(), '\x00') {
		return nil, status.Error(codes.InvalidArgument, "invalid secret value")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	full := s.SecretPrefix + request.GetName()
	exists, err := s.Podman.SecretExists(full)
	if err != nil {
		s.log().Error("control request failed", "method", "WriteSecretValue", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if exists {
		if err := s.Podman.SecretRemove(full); err != nil {
			s.log().Error("control request failed", "method", "WriteSecretValue", "name", request.GetName(), "error", err)
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	if err := s.Podman.SecretCreate(full, request.GetValue()); err != nil {
		s.log().Error("control request failed", "method", "WriteSecretValue", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "WriteSecretValue", "name", request.GetName())
	return &ctl.Secret{Name: request.GetName()}, nil
}

// RemoveSecret deletes a secret under the orchestrator's prefix.
func (s *Server) RemoveSecret(_ context.Context, request *ctl.RemoveSecretRequest) (*ctl.RemoveSecretResponse, error) {
	s.log().Info("control request", "method", "RemoveSecret", "name", request.GetName())
	if !secretName.MatchString(request.GetName()) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret name %q", request.GetName()))
	}
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if slug, container, usage, inUse := secretInUse(workspaces, request.GetName()); inUse {
		return nil, status.Error(codes.FailedPrecondition, fmt.Sprintf("secret %q is %s workspace %q container %q", request.GetName(), usage, slug, container))
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	full := s.SecretPrefix + request.GetName()
	exists, err := s.Podman.SecretExists(full)
	if err != nil {
		s.log().Error("control request failed", "method", "RemoveSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if !exists {
		return nil, status.Error(codes.NotFound, fmt.Sprintf("secret %q not found", request.GetName()))
	}
	if err := s.Podman.SecretRemove(full); err != nil {
		s.log().Error("control request failed", "method", "RemoveSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveSecret", "name", request.GetName())
	return &ctl.RemoveSecretResponse{}, nil
}

// AddContainerSecret attaches an existing secret to a container as an
// environment variable and recreates the container so the change takes
// effect.
func (s *Server) AddContainerSecret(ctx context.Context, request *ctl.AddContainerSecretRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "AddContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "env", request.GetEnv(), "secret", request.GetSecret())
	container := request.GetContainer()
	if container == "" {
		container = "default"
	}
	if container != "default" && !validContainerName(container) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid container name %q", container))
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, container)
	if !ok {
		s.log().Warn("control request failed", "method", "AddContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
		return nil, containerNotFoundError(container, request.GetWorkspaceSlug())
	}
	snapshot := snapshotContainer(*record)
	if err := validateEnvKey(request.GetEnv()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if !secretName.MatchString(request.GetSecret()) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret name %q", request.GetSecret()))
	}
	if _, exists := record.SecretEnv[request.GetEnv()]; exists {
		return nil, status.Error(codes.AlreadyExists, fmt.Sprintf("env var %q already has a secret", request.GetEnv()))
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	// Validate the new reference before mutating so a missing secret fails with
	// NOT_FOUND instead of surfacing podman's internal naming after the old
	// container was already removed.
	if err := s.validateSecretReferences(map[string]string{request.GetEnv(): request.GetSecret()}, record.Mounts); err != nil {
		return nil, err
	}
	if record.SecretEnv == nil {
		record.SecretEnv = map[string]string{}
	}
	record.SecretEnv[request.GetEnv()] = request.GetSecret()
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		return nil, err
	}
	s.containerEnvSecrets(record.SecretEnv)
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secretToken, err := s.ensureAgentToken(record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateOrRestore(workspace, record, imageTag, secretToken, &snapshot); err != nil {
		s.log().Error("control request failed", "method", "AddContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = secretToken
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "AddContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "env", request.GetEnv())
	return containerProto(updated, *record), nil
}

// RemoveContainerSecret detaches a secret environment variable from a
// container and recreates the container so the change takes effect.
func (s *Server) RemoveContainerSecret(ctx context.Context, request *ctl.RemoveContainerSecretRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "RemoveContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "env", request.GetEnv())
	container := request.GetContainer()
	if container == "" {
		container = "default"
	}
	if container != "default" && !validContainerName(container) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid container name %q", container))
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, container)
	if !ok {
		s.log().Warn("control request failed", "method", "RemoveContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
		return nil, containerNotFoundError(container, request.GetWorkspaceSlug())
	}
	snapshot := snapshotContainer(*record)
	if err := validateEnvKey(request.GetEnv()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if _, ok := record.SecretEnv[request.GetEnv()]; !ok {
		return nil, status.Error(codes.NotFound, fmt.Sprintf("env var %q is not bound to any secret", request.GetEnv()))
	}
	delete(record.SecretEnv, request.GetEnv())
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		return nil, err
	}
	s.containerEnvSecrets(record.SecretEnv)
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secretToken, err := s.ensureAgentToken(record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateOrRestore(workspace, record, imageTag, secretToken, &snapshot); err != nil {
		s.log().Error("control request failed", "method", "RemoveContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = secretToken
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "env", request.GetEnv())
	return containerProto(updated, *record), nil
}
