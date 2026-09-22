// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package version

import "testing"

func TestCore(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  string
	}{
		{"1.2.3", "1.2.3"},
		{"0.2.0-rc.3", "0.2.0"},
		{"1.2.3-4-gabc123", "1.2.3"},
		{"1.2.3+build", "1.2.3"},
		{"1.2", ""},
		{"1.2.x", ""},
		{"dev", ""},
		{"unknown", ""},
		{"", ""},
		{"1.2.3.4", ""},
	} {
		if got := Core(tc.value); got != tc.want {
			t.Errorf("Core(%q) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestMajor(t *testing.T) {
	if got := Major("1.2.3"); got != 1 {
		t.Errorf("Major(1.2.3) = %d, want 1", got)
	}
	if got := Major("0.2.0-rc.3"); got != 0 {
		t.Errorf("Major(0.2.0-rc.3) = %d, want 0", got)
	}
	if got := Major("dev"); got != -1 {
		t.Errorf("Major(dev) = %d, want -1", got)
	}
}

func TestCompare(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want int
	}{
		{"1.2.3", "1.2.3", 0},
		{"1.2.3", "1.2.4", -1},
		{"1.3.0", "1.2.9", 1},
		{"2.0.0", "1.9.9", 1},
		{"0.2.0-rc.3", "0.2.0", 0},
		{"1.2.3-4-gabc", "1.2.3", 0},
		{"dev", "1.2.3", -1},
		{"1.2.3", "dev", -1},
	} {
		if got := Compare(tc.a, tc.b); got != tc.want {
			t.Errorf("Compare(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}
