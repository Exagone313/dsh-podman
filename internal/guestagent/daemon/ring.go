// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package daemon

import "sync"

type ring struct {
	mu     sync.Mutex
	buffer []byte
	cap    int
}

func newRing(capacity int) *ring {
	return &ring{cap: capacity}
}

func (r *ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(p) >= r.cap {
		r.buffer = append(r.buffer[:0], p[len(p)-r.cap:]...)
		return len(p), nil
	}
	if len(r.buffer)+len(p) > r.cap {
		r.buffer = r.buffer[len(r.buffer)+len(p)-r.cap:]
	}
	r.buffer = append(r.buffer, p...)
	return len(p), nil
}

func (r *ring) Tail(n int) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n <= 0 || n >= len(r.buffer) {
		return append([]byte(nil), r.buffer...)
	}
	return append([]byte(nil), r.buffer[len(r.buffer)-n:]...)
}
