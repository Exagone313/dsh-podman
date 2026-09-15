// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package identity

import (
	"syscall"
	"testing"
)

func TestCredential(t *testing.T) {
	uid1000 := uint32(1000)
	gid2000 := uint32(2000)
	cases := []struct {
		name string
		opts Options
		want *syscall.Credential
	}{
		{name: "neither", opts: Options{}, want: nil},
		{name: "groups only", opts: Options{Groups: []uint32{3000}}, want: &syscall.Credential{Groups: []uint32{3000}}},
		{name: "uid only", opts: Options{Uid: &uid1000}, want: &syscall.Credential{Uid: 1000, Gid: 1000}},
		{name: "gid only", opts: Options{Gid: &gid2000}, want: &syscall.Credential{Uid: 0, Gid: 2000}},
		{name: "both", opts: Options{Uid: &uid1000, Gid: &gid2000}, want: &syscall.Credential{Uid: 1000, Gid: 2000}},
		{name: "uid with groups", opts: Options{Uid: &uid1000, Groups: []uint32{3000}}, want: &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{3000}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Credential(tc.opts)
			if tc.want == nil {
				if got != nil {
					t.Fatalf("Credential() = %+v, want nil", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("Credential() = nil, want %+v", tc.want)
			}
			if got.Uid != tc.want.Uid || got.Gid != tc.want.Gid {
				t.Fatalf("Credential() = %+v, want uid=%d gid=%d", got, tc.want.Uid, tc.want.Gid)
			}
			if len(got.Groups) != len(tc.want.Groups) {
				t.Fatalf("Credential() groups = %v, want %v", got.Groups, tc.want.Groups)
			}
			for i := range tc.want.Groups {
				if got.Groups[i] != tc.want.Groups[i] {
					t.Fatalf("Credential() groups = %v, want %v", got.Groups, tc.want.Groups)
				}
			}
		})
	}
}

func TestEffectiveIdentity(t *testing.T) {
	uid1000 := uint32(1000)
	gid2000 := uint32(2000)
	cases := []struct {
		name    string
		opts    Options
		wantUid uint32
		wantGid uint32
	}{
		{name: "neither", opts: Options{}},
		{name: "uid only", opts: Options{Uid: &uid1000}, wantUid: 1000, wantGid: 1000},
		{name: "gid only", opts: Options{Gid: &gid2000}, wantGid: 2000},
		{name: "both", opts: Options{Uid: &uid1000, Gid: &gid2000}, wantUid: 1000, wantGid: 2000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.opts.EffectiveUid(); got != tc.wantUid {
				t.Errorf("EffectiveUid() = %d, want %d", got, tc.wantUid)
			}
			if got := tc.opts.EffectiveGid(); got != tc.wantGid {
				t.Errorf("EffectiveGid() = %d, want %d", got, tc.wantGid)
			}
		})
	}
}
