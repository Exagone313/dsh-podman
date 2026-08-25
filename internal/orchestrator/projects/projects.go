package projects

import (
	"os"
	"path/filepath"
	"sort"
)

type Project struct{ Name, HostPath string }

func List(root string) ([]Project, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	result := make([]Project, 0)
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "." || entry.Name() == ".." {
			continue
		}
		path, err := filepath.Abs(filepath.Join(root, entry.Name()))
		if err != nil {
			return nil, err
		}
		result = append(result, Project{Name: entry.Name(), HostPath: path})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}
