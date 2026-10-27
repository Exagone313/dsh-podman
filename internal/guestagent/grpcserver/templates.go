// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// templateDirectory is where a project's container templates live, below the
// project root. It is created on the first save.
const templateDirectory = ".dsh-podman"

// templateExtensions are the suffixes a template file may carry. A name without
// one gets the canonical ".yml" appended.
var templateExtensions = []string{".yml", ".yaml"}

// templateFileName validates a template name as a plain basename and returns
// the file name to create. A caller cannot traverse out of .dsh-podman: any
// separator, a "." or ".." segment, an absolute name, or a hidden leading dot is
// refused. The YAML suffix is accepted and kept, so a name typed as "web.yml"
// and one typed as "web" land on the same file.
func templateFileName(name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("template name is required")
	}
	if len(name) > 200 {
		return "", fmt.Errorf("template name %q is too long", name)
	}
	if strings.ContainsAny(name, "/\\\x00\n\r") {
		return "", fmt.Errorf("template name %q must be a plain basename with no path separators", name)
	}
	if name == "." || name == ".." || strings.HasPrefix(name, ".") {
		return "", fmt.Errorf("template name %q must be a plain basename", name)
	}
	for _, extension := range templateExtensions {
		if strings.HasSuffix(name, extension) {
			return name, nil
		}
	}
	return name + ".yml", nil
}

// WriteTemplate writes a template into the project's .dsh-podman directory,
// creating the directory when it is missing. The project directory is resolved
// through the same mount-confined filesystem as the file API, so a read-only
// project mount is refused before any I/O with a clean permission error rather
// than surfacing the write failure of the mount itself.
func (s *Server) WriteTemplate(_ context.Context, request *guest.WriteTemplateRequest) (*guest.WriteTemplateResponse, error) {
	projectDir := request.GetProjectDir()
	fileName, err := templateFileName(request.GetName())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if len(request.GetContent()) == 0 {
		return nil, status.Error(codes.InvalidArgument, "template content is empty")
	}
	slog.Info("guest agent WriteTemplate requested", "project_dir", projectDir, "name", fileName)
	// Resolve the project directory read-only first: the mount root itself is
	// never a write target, and a missing project must not be created by the
	// save. The template directory inside it is resolved for writing, so a
	// read-only project mount is refused before any I/O.
	directory, err := s.resolve(projectDir, false)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, fmt.Sprintf("cannot save template %q: %v", fileName, err))
	}
	info, err := os.Stat(directory)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, status.Error(codes.NotFound, fmt.Sprintf("project directory %q does not exist", projectDir))
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	if !info.IsDir() {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("project directory %q is not a directory", projectDir))
	}
	targetDir, err := s.resolve(filepath.Join(projectDir, templateDirectory), true)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, fmt.Sprintf("cannot save template %q: %v", fileName, err))
	}
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return nil, status.Error(writeErrorCode(err), fmt.Sprintf("cannot create %s: %v", templateDirectory, err))
	}
	target := filepath.Join(targetDir, fileName)
	// Write through a sibling temp file so a failed write never leaves a
	// truncated template behind, and preserve an existing file's mode.
	mode := os.FileMode(0644)
	if existing, statErr := os.Stat(target); statErr == nil {
		mode = existing.Mode().Perm()
	}
	temporary, err := os.CreateTemp(targetDir, ".dsh-template-*")
	if err != nil {
		return nil, status.Error(writeErrorCode(err), fmt.Sprintf("cannot save template %q: %v", fileName, err))
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return nil, status.Error(codes.Internal, err.Error())
	}
	if _, err := temporary.Write(request.GetContent()); err != nil {
		temporary.Close()
		return nil, status.Error(writeErrorCode(err), fmt.Sprintf("cannot save template %q: %v", fileName, err))
	}
	if err := temporary.Close(); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := os.Rename(temporaryName, target); err != nil {
		return nil, status.Error(writeErrorCode(err), fmt.Sprintf("cannot save template %q: %v", fileName, err))
	}
	slog.Info("guest agent WriteTemplate completed", "path", target)
	return &guest.WriteTemplateResponse{Path: target}, nil
}
