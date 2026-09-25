// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcopts

import "testing"

// TestPolicyPermitsPluginPings guards the contract with the plugin: a server
// MinTime at or above the plugin's interval would answer its pings with GOAWAY
// "too many pings" all over again.
func TestPolicyPermitsPluginPings(t *testing.T) {
	if minPingInterval >= PluginPingInterval {
		t.Fatalf(
			"server MinTime %s would reject the plugin's %s pings",
			minPingInterval,
			PluginPingInterval,
		)
	}
	if KeepalivePolicy() == nil {
		t.Fatal("KeepalivePolicy returned a nil server option")
	}
}
