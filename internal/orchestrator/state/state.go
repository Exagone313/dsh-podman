package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

type Image struct {
	ImageID   string   `toml:"image_id"`
	BaseImage string   `toml:"base_image"`
	Packages  []string `toml:"packages"`
	ImageTag  string   `toml:"image_tag"`
	BuiltAt   string   `toml:"built_at"`
}
type Mount struct {
	ProjectName string `toml:"project_name"`
	Mode        string `toml:"mode"`
}
type Workspace struct {
	WorkspaceSlug   string  `toml:"workspace_slug"`
	ContainerName   string  `toml:"container_name"`
	ImageID         string  `toml:"image_id"`
	Mounts          []Mount `toml:"mounts"`
	Status          string  `toml:"status"`
	AgentSocketPath string  `toml:"agent_socket_path"`
	AgentToken      string  `toml:"agent_token"`
	CreatedAt       string  `toml:"created_at"`
}
type imagesFile struct {
	Images []Image `toml:"images"`
}
type workspacesFile struct {
	Workspaces []Workspace `toml:"workspaces"`
}

type Store struct{ dir string }

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
	var file imagesFile
	if err := s.read("images.toml", &file); err != nil {
		return nil, err
	}
	return file.Images, nil
}
func (s *Store) SaveImages(images []Image) error {
	return s.write("images.toml", imagesFile{Images: images})
}
func (s *Store) Workspaces() ([]Workspace, error) {
	var file workspacesFile
	if err := s.read("workspaces.toml", &file); err != nil {
		return nil, err
	}
	return file.Workspaces, nil
}
func (s *Store) SaveWorkspaces(workspaces []Workspace) error {
	return s.write("workspaces.toml", workspacesFile{Workspaces: workspaces})
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
