// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"sort"

	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
)

// rebuildGraph indexes stored images for rebuild planning: byID maps short
// image ids to their records (last occurrence wins) and dependents maps each
// short image id to the sorted list of image ids whose parent is that id.
func rebuildGraph(images []state.Image) (byID map[string]state.Image, dependents map[string][]string) {
	byID = make(map[string]state.Image, len(images))
	for _, image := range images {
		byID[image.ImageID] = image
	}
	dependents = make(map[string][]string)
	for _, image := range images {
		if owner, ok := byID[image.Parent]; ok {
			dependents[owner.ImageID] = append(dependents[owner.ImageID], image.ImageID)
		}
	}
	for owner := range dependents {
		sort.Strings(dependents[owner])
	}
	return byID, dependents
}

// rebuildPlan computes the deterministic rebuild plan for the stored custom
// images. It returns the ordered list of images to rebuild, with every parent
// preceding its dependents, and the list of image ids to skip.
//
// A parent that names a base image is always usable: bases are ensured before
// custom images are rebuilt. A parent that cannot be resolved to a stored
// custom image is skipped, as are any images left over by a dependency cycle.
func rebuildPlan(images []state.Image) (ordered []state.Image, skipped []string) {
	byID, dependents := rebuildGraph(images)

	settled := make(map[string]bool, len(images))
	rebuilt := make(map[string]bool, len(images))

	var markSkipped func(id string)
	markSkipped = func(id string) {
		if settled[id] {
			return
		}
		settled[id] = true
		skipped = append(skipped, id)
		for _, dependent := range dependents[id] {
			markSkipped(dependent)
		}
	}

	candidates := make([]string, 0, len(images))
	for _, image := range images {
		candidates = append(candidates, image.ImageID)
	}
	sort.Strings(candidates)
	remaining := make(map[string]bool, len(candidates))
	for _, id := range candidates {
		remaining[id] = true
	}

	for len(remaining) > 0 {
		progress := false
		for _, id := range candidates {
			if !remaining[id] {
				continue
			}
			if settled[id] {
				delete(remaining, id)
				continue
			}
			image := byID[id]
			if image.Parent == "" {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			if _, isBase := imagebuild.BaseImageByID(image.Parent); isBase {
				settled[id] = true
				rebuilt[id] = true
				ordered = append(ordered, image)
				delete(remaining, id)
				progress = true
				continue
			}
			owner, ok := byID[image.Parent]
			if !ok {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			if !settled[owner.ImageID] {
				continue
			}
			if !rebuilt[owner.ImageID] {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			settled[id] = true
			rebuilt[id] = true
			ordered = append(ordered, image)
			delete(remaining, id)
			progress = true
		}
		if !progress {
			leftover := make([]string, 0, len(remaining))
			for id := range remaining {
				leftover = append(leftover, id)
			}
			sort.Strings(leftover)
			for _, id := range leftover {
				markSkipped(id)
			}
			break
		}
	}
	return ordered, skipped
}

// skipDependents returns failedID and all of its transitive dependents: the
// image ids that must be skipped when failedID's rebuild fails.
func skipDependents(dependents map[string][]string, failedID string) []string {
	skipped := make([]string, 0)
	seen := make(map[string]bool)
	var walk func(id string)
	walk = func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		skipped = append(skipped, id)
		for _, dependent := range dependents[id] {
			walk(dependent)
		}
	}
	walk(failedID)
	return skipped
}
