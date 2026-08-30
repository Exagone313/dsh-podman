// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/pelletier/go-toml/v2"
)

type Image struct {
	ImageID        string   `toml:"image_id"`
	Parent         string   `toml:"parent,omitempty"`
	PackageManager string   `toml:"package_manager,omitempty"`
	Packages       []string `toml:"packages"`
	ImageTag       string   `toml:"image_tag"`
	BuiltAt        string   `toml:"built_at"`
}
type Mount struct {
	ProjectName string `toml:"project_name"`
	Mode        string `toml:"mode"`
	Path        string `toml:"path,omitempty"`
	Destination string `toml:"destination,omitempty"`
	Kind        string `toml:"kind,omitempty"`
	Volume      string `toml:"volume,omitempty"`
	Secret      string `toml:"secret,omitempty"`
}
type Container struct {
	Name            string            `toml:"name"` // "default" or logical name
	PodmanName      string            `toml:"podman_name"`
	ImageID         string            `toml:"image_id"`
	Status          string            `toml:"status"`
	CreatedAt       string            `toml:"created_at"`
	AgentSocketPath string            `toml:"agent_socket_path"`
	AgentToken      string            `toml:"agent_token"`
	Mounts          []Mount           `toml:"mounts"`
	Env             map[string]string `toml:"env,omitempty"`
	SecretEnv       map[string]string `toml:"secret_env,omitempty"`
}
type Workspace struct {
	WorkspaceSlug   string      `toml:"workspace_slug"`
	ContainerName   string      `toml:"container_name"`
	ImageID         string      `toml:"image_id"`
	Mounts          []Mount     `toml:"mounts"`
	Status          string      `toml:"status"`
	AgentSocketPath string      `toml:"agent_socket_path"`
	AgentToken      string      `toml:"agent_token"`
	CreatedAt       string      `toml:"created_at"`
	Containers      []Container `toml:"containers"`
}
type imagesFile struct {
	Images []Image `toml:"images"`
}
type workspacesFile struct {
	Workspaces []Workspace `toml:"workspaces"`
}

type Store struct {
	dir string
	mu  sync.Mutex
}

func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}
func (s *Store) Images() ([]Image, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.images()
}
func (s *Store) images() ([]Image, error) {
	var file imagesFile
	if err := s.read("images.toml", &file); err != nil {
		return nil, err
	}
	return file.Images, nil
}
func (s *Store) SaveImages(images []Image) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveImages(images)
}
func (s *Store) saveImages(images []Image) error {
	return s.write("images.toml", imagesFile{Images: images})
}
func (s *Store) Workspaces() ([]Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.workspaces()
}
func (s *Store) workspaces() ([]Workspace, error) {
	var file workspacesFile
	if err := s.read("workspaces.toml", &file); err != nil {
		return nil, err
	}
	for i := range file.Workspaces {
		if len(file.Workspaces[i].Containers) == 0 && file.Workspaces[i].ContainerName != "" {
			file.Workspaces[i].Containers = []Container{{
				Name:            "default",
				PodmanName:      file.Workspaces[i].ContainerName,
				ImageID:         file.Workspaces[i].ImageID,
				Status:          file.Workspaces[i].Status,
				CreatedAt:       file.Workspaces[i].CreatedAt,
				AgentSocketPath: file.Workspaces[i].AgentSocketPath,
				AgentToken:      file.Workspaces[i].AgentToken,
			}}
		}
	}
	return file.Workspaces, nil
}
func (s *Store) SaveWorkspaces(workspaces []Workspace) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveWorkspaces(workspaces)
}
func (s *Store) saveWorkspaces(workspaces []Workspace) error {
	return s.write("workspaces.toml", workspacesFile{Workspaces: workspaces})
}
func (s *Store) UpdateImages(update func([]Image) ([]Image, error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.images()
	if err != nil {
		return err
	}
	next, err := update(current)
	if err != nil {
		return err
	}
	return s.saveImages(next)
}
func (s *Store) UpdateWorkspaces(update func([]Workspace) ([]Workspace, error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.workspaces()
	if err != nil {
		return err
	}
	next, err := update(current)
	if err != nil {
		return err
	}
	return s.saveWorkspaces(next)
}
func (s *Store) read(name string, target any) error {
	data, err := os.ReadFile(filepath.Join(s.dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return toml.Unmarshal(data, target)
}
func (s *Store) write(name string, value any) error {
	data, err := toml.Marshal(value)
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, name)
	temp, err := os.CreateTemp(s.dir, ".state-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(data)
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tempName, path); err != nil {
		return fmt.Errorf("replace %s: %w", name, err)
	}
	return os.Chmod(path, 0600)
}
