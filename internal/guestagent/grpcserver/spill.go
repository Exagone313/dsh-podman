// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"
	"log/slog"
	"os"
	"sync"
)

// spillWriter keeps a bounded full-stream copy of one output stream on disk so
// a caller can recover output that was truncated in memory. The copy is
// complete while the stream stays within maxBytes; the first byte past the cap
// makes it incomplete, so the file is removed and the writer reports invalid.
// The caller owns the path and removes a valid-but-unneeded file itself.
type spillWriter struct {
	mu       sync.Mutex
	file     *os.File
	path     string
	maxBytes int64
	written  int64
	invalid  bool
	closed   bool
}

func newSpillWriter(path string, maxBytes int64) (*spillWriter, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("spill max_bytes must be positive")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	return &spillWriter{file: file, path: path, maxBytes: maxBytes}, nil
}

// write appends one chunk, discarding the copy once the cap is exceeded.
func (w *spillWriter) write(chunk []byte) {
	if w == nil || len(chunk) == 0 {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.invalid {
		return
	}
	if w.written+int64(len(chunk)) > w.maxBytes {
		w.discardLocked()
		return
	}
	n, err := w.file.Write(chunk)
	w.written += int64(n)
	if err != nil {
		w.discardLocked()
	}
}

func (w *spillWriter) discardLocked() {
	w.invalid = true
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}
	_ = os.Remove(w.path)
}

// valid reports whether the on-disk copy holds the complete stream.
func (w *spillWriter) valid() bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return !w.invalid
}

// close seals the copy; the file stays on disk for the caller to read or remove.
func (w *spillWriter) close() {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}
}

// newSpill validates and opens the requested spill file, or returns nil when
// spilling is not requested or the path is not reachable. A missing spill never
// fails the command.
func (s *Server) newSpill(path string, maxBytes int64) *spillWriter {
	if path == "" || maxBytes <= 0 {
		return nil
	}
	if s.FS != nil {
		resolved, _, err := s.FS.Resolve(path, true)
		if err != nil {
			slog.Warn("guest agent spill path rejected", "path", path, "error", err)
			return nil
		}
		path = resolved
	}
	writer, err := newSpillWriter(path, maxBytes)
	if err != nil {
		slog.Warn("guest agent spill unavailable", "path", path, "error", err)
		return nil
	}
	return writer
}
