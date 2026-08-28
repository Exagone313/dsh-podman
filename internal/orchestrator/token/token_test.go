// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package token

import "testing"

func TestNewReturnsURLSafeToken(t *testing.T) {
	value, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if len(value) == 0 {
		t.Fatal("empty token")
	}
	for _, r := range value {
		alphanumeric := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !alphanumeric && r != '-' && r != '_' {
			t.Fatalf("token contains non-URL-safe character %q", r)
		}
	}
}

func TestNewIsRandom(t *testing.T) {
	first, err := New()
	if err != nil {
		t.Fatal(err)
	}
	second, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two tokens are identical")
	}
}

func TestNewHasExpectedEntropy(t *testing.T) {
	value, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 43 {
		t.Fatalf("expected 43-character base64url token, got %d", len(value))
	}
}
