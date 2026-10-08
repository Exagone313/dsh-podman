// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The transport a published pod port speaks. Only TCP is implemented; udp and
// http are reserved on the wire so a later publish does not have to change the
// request shape.
const PROTOCOLS: Record<string, string> = {
  tcp: "PROTOCOL_TCP",
  udp: "PROTOCOL_UDP",
  http: "PROTOCOL_HTTP",
};

const PROTOCOL_FROM_PROTO: Record<string, string> = {
  PROTOCOL_TCP: "tcp",
  PROTOCOL_UDP: "udp",
  PROTOCOL_HTTP: "http",
};

/** The protocol a call uses when it does not name one. */
export const DEFAULT_PORT_PROTOCOL = "tcp";

/** The logical protocol for a proto enum value, or undefined when unspecified. */
export function portProtocolFromProto(
  proto: string | undefined,
): string | undefined {
  if (proto === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(PROTOCOL_FROM_PROTO, proto)
    ? PROTOCOL_FROM_PROTO[proto]
    : undefined;
}

/** The proto enum value for a logical protocol name. */
export function portProtocolToProto(protocol: string | undefined): string {
  const name = protocol ?? DEFAULT_PORT_PROTOCOL;
  const proto = Object.prototype.hasOwnProperty.call(PROTOCOLS, name)
    ? PROTOCOLS[name]
    : undefined;
  if (proto === undefined) {
    throw new Error(`unknown port protocol: ${JSON.stringify(protocol)}`);
  }
  return proto;
}
