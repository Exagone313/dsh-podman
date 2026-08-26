package projects

import (
	"os"
	"path/filepath"
	"sort"
)

type Project struct{ Name, HostPath string }

func List(root string) ([]Project, error) {
	result := make([]Project, 0)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root || !entry.IsDir() {
			return nil
		}
		name, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		result = append(result, Project{Name: filepath.ToSlash(name), HostPath: absolute})
		return nil
	})
	if err != nil {
		return nil, err
	}
	for i := range result {
		result[i].Name = filepath.ToSlash(result[i].Name)
	}
	if len(result) == 0 {
		if _, err := os.Stat(root); err != nil {
			return nil, err
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}
