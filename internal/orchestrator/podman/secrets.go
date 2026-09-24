// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"fmt"
	"strings"

	"go.podman.io/podman/v6/pkg/bindings/secrets"
)

func (c *Client) SecretExists(name string) (bool, error) {
	ctx, cancel := c.lookupContext()
	defer cancel()
	return secrets.Exists(ctx, name)
}

// SecretCreate stores a secret value under the given name. The value is never
// logged; only the name is.
func (c *Client) SecretCreate(name, value string) error {
	if _, err := secrets.Create(c.ctx, strings.NewReader(value), &secrets.CreateOptions{Name: &name}); err != nil {
		c.log().Error("secret creation failed", "secret_name", name, "error", err)
		return fmt.Errorf("create secret: %w", err)
	}
	c.log().Info("secret created", "secret_name", name)
	return nil
}

// SecretList returns the full podman names of every secret.
func (c *Client) SecretList() ([]string, error) {
	ctx, cancel := c.lookupContext()
	defer cancel()
	reports, err := secrets.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(reports))
	for _, report := range reports {
		names = append(names, report.Spec.Name)
	}
	return names, nil
}

func (c *Client) SecretRemove(name string) error {
	if err := secrets.Remove(c.ctx, name); err != nil {
		c.log().Error("secret removal failed", "secret_name", name, "error", err)
		return fmt.Errorf("remove secret: %w", err)
	}
	c.log().Info("secret removed", "secret_name", name)
	return nil
}
