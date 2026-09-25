// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import "testing"

func TestGuestMountsEmpty(t *testing.T) {
	mounts, err := guestMounts("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(mounts) != 0 {
		t.Fatalf("expected no mounts, got %#v", mounts)
	}
}

func TestGuestMounts(t *testing.T) {
	mounts, err := guestMounts(`[{"path":"/data","read_only":false},{"path":"/var/log","read_only":true}]`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(mounts) != 2 {
		t.Fatalf("expected 2 mounts, got %#v", mounts)
	}
	if mounts[0].Virtual != "/data" || mounts[0].Host != "/data" || mounts[0].ReadOnly {
		t.Fatalf("unexpected first mount: %#v", mounts[0])
	}
	if mounts[1].Virtual != "/var/log" || mounts[1].Host != "/var/log" || !mounts[1].ReadOnly {
		t.Fatalf("unexpected second mount: %#v", mounts[1])
	}
}

func TestGuestMountsRejectsMalformed(t *testing.T) {
	if _, err := guestMounts("not json"); err == nil {
		t.Fatal("expected an error for malformed JSON")
	}
	if _, err := guestMounts(`[{"path":"relative","read_only":false}]`); err == nil {
		t.Fatal("expected an error for a relative mount path")
	}
}
