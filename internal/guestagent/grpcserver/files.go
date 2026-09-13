// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Server) ReadFile(request *guest.ReadFileRequest, stream guest.WorkspaceGuestAgent_ReadFileServer) error {
	slog.Info("guest agent ReadFile requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), false)
	if err != nil {
		return status.Error(codes.PermissionDenied, err.Error())
	}
	file, err := os.Open(path)
	if err != nil {
		return status.Error(codes.NotFound, err.Error())
	}
	defer file.Close()
	if request.GetOffset() > 0 {
		if _, err := file.Seek(request.GetOffset(), io.SeekStart); err != nil {
			return status.Error(codes.Internal, err.Error())
		}
	}
	remaining := request.GetLength()
	limited := remaining > 0
	buffer := make([]byte, 32*1024)
	for {
		readSize := len(buffer)
		if limited && int64(readSize) > remaining {
			readSize = int(remaining)
		}
		n, readErr := file.Read(buffer[:readSize])
		if n > 0 {
			if limited {
				remaining -= int64(n)
			}
			if err := stream.Send(&guest.ReadFileChunk{Data: append([]byte(nil), buffer[:n]...)}); err != nil {
				return err
			}
			if limited && remaining == 0 {
				return nil
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return status.Error(codes.Internal, readErr.Error())
		}
	}
}

func (s *Server) WriteFile(stream guest.WorkspaceGuestAgent_WriteFileServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	start := first.GetStart()
	if start == nil {
		return status.Error(codes.InvalidArgument, "first write message must be start")
	}
	slog.Info("guest agent WriteFile requested", "path", start.GetPath())
	path, err := s.resolve(start.GetPath(), true)
	if err != nil {
		return status.Error(codes.PermissionDenied, err.Error())
	}
	flags := os.O_WRONLY
	if start.GetCreate() {
		flags |= os.O_CREATE
	}
	if start.GetTruncate() {
		flags |= os.O_TRUNC
	}
	if !start.GetCreate() {
		if _, statErr := os.Stat(path); statErr != nil {
			return status.Error(codes.NotFound, statErr.Error())
		}
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".dsh-write-*")
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	// Preserve the target's permission bits (a new file gets the usual 0644)
	// so a write does not silently drop an executable bit.
	mode := os.FileMode(0644)
	if info, statErr := os.Stat(path); statErr == nil {
		mode = info.Mode().Perm()
	}
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return status.Error(codes.Internal, err.Error())
	}
	file := temporary
	var written int64
	for {
		chunk, recvErr := stream.Recv()
		if errors.Is(recvErr, io.EOF) {
			if err := file.Close(); err != nil {
				return status.Error(codes.Internal, err.Error())
			}
			if err := os.Rename(temporaryName, path); err != nil {
				return status.Error(codes.Internal, err.Error())
			}
			return stream.SendAndClose(&guest.WriteFileResponse{BytesWritten: written})
		}
		if recvErr != nil {
			return recvErr
		}
		if data := chunk.GetDataChunk(); len(data) > 0 {
			n, writeErr := file.Write(data)
			written += int64(n)
			if writeErr != nil {
				return status.Error(codes.Internal, writeErr.Error())
			}
		}
	}
}

func (s *Server) Stat(_ context.Context, request *guest.StatRequest) (*guest.StatResponse, error) {
	slog.Info("guest agent Stat requested", "path", request.GetPath())
	noFollow := request.GetNoFollow()
	var path string
	var err error
	if noFollow {
		path, err = s.resolveEntry(request.GetPath())
	} else {
		path, err = s.resolve(request.GetPath(), false)
	}
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	var info os.FileInfo
	if noFollow {
		info, err = os.Lstat(path)
	} else {
		info, err = os.Stat(path)
	}
	if err != nil {
		if os.IsNotExist(err) {
			return &guest.StatResponse{}, nil
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.StatResponse{Exists: true, IsDir: info.IsDir(), Size: info.Size(), Mode: info.Mode().String(), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano), IsSymlink: noFollow && info.Mode()&os.ModeSymlink != 0}, nil
}

func (s *Server) ReadDir(_ context.Context, request *guest.ReadDirRequest) (*guest.ReadDirResponse, error) {
	slog.Info("guest agent ReadDir requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), false)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &guest.ReadDirResponse{}
	for _, entry := range entries {
		// Follow the entry to report the target's type, matching the harness's
		// local backend `probe` semantics: a broken symlink or special file is
		// `other`, and a symlink to a directory reports `directory`.
		info, infoErr := os.Stat(filepath.Join(path, entry.Name()))
		if infoErr != nil {
			result.Entries = append(result.Entries, &guest.DirEntry{Name: entry.Name(), Type: "other"})
			continue
		}
		entryType := "other"
		switch {
		case info.IsDir():
			entryType = "directory"
		case info.Mode().IsRegular():
			entryType = "file"
		}
		result.Entries = append(result.Entries, &guest.DirEntry{Name: entry.Name(), IsDir: info.IsDir(), Size: info.Size(), Type: entryType})
	}
	return result, nil
}

func (s *Server) Mkdir(_ context.Context, request *guest.MkdirRequest) (*guest.MkdirResponse, error) {
	slog.Info("guest agent Mkdir requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), true)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	if request.GetParents() {
		err = os.MkdirAll(path, 0755)
	} else {
		err = os.Mkdir(path, 0755)
	}
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.MkdirResponse{}, nil
}

func (s *Server) Delete(_ context.Context, request *guest.DeleteRequest) (*guest.DeleteResponse, error) {
	slog.Info("guest agent Delete requested", "path", request.GetPath())
	path, err := s.resolve(request.GetPath(), true)
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	if request.GetRecursive() {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &guest.DeleteResponse{}, nil
}
