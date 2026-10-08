// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package proxy moves bytes between two connections. Both forwarding hops of a
// published port use it: the gateway (host loopback to a published Unix socket)
// and the guest agent (published Unix socket to a port in the pod).
package proxy

import (
	"errors"
	"io"
	"net"
)

// Pipe copies in both directions until both are done. Each source's EOF
// half-closes the other side, so a request/response protocol such as HTTP sees
// the end of its request instead of waiting for the whole connection. Neither
// connection is closed: the caller owns them.
func Pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	half := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		closeWrite(dst)
		done <- struct{}{}
	}
	go half(a, b)
	go half(b, a)
	<-done
	<-done
}

// closeWrite half-closes the write side when the connection supports it, which
// both *net.TCPConn and *net.UnixConn do.
func closeWrite(conn net.Conn) {
	if cw, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
	}
}

// Serve accepts connections on ln and hands each to dial. A dial failure closes
// that client and reports it through onError; an accept failure ends the loop,
// which is what closing the listener does. It returns when the loop ends.
func Serve(ln net.Listener, dial func() (net.Conn, error), onError func(error)) {
	for {
		client, err := ln.Accept()
		if err != nil {
			if onError != nil && !errors.Is(err, net.ErrClosed) {
				onError(err)
			}
			return
		}
		go func() {
			upstream, err := dial()
			if err != nil {
				if onError != nil {
					onError(err)
				}
				_ = client.Close()
				return
			}
			defer upstream.Close()
			defer client.Close()
			Pipe(client, upstream)
		}()
	}
}
