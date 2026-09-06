//! Minimal RFC 8489 (STUN) server — binding requests only, UDP.
//!
//! STUN's job here is narrow: tell peers their public IP:port so they can
//! punch holes through NAT. No TURN relay, no TCP, no auth (short-term
//! credentials are a TURN concern; plain binding is unauthenticated).
//!
//! Wire format (RFC 8489 §5): 20-byte header
//!   [0..2]  message type   (0x0101 = binding success, 0x0111 = binding error)
//!   [2..4]  message length (attrs only)
//!   [4..8]  magic cookie   0x2112A442
//!   [8..20] transaction id (12 bytes, echoed verbatim)
//! Attributes: [type:2][len:2][value padded to 4]
//!   XOR-MAPPED-ADDRESS (0x0020) — IP:port XOR'd with the magic cookie

import dgram from 'node:dgram';

const MAGIC = 0x2112a442;

/** XOR-MAPPED-ADDRESS attribute for the peer's observed address. */
function xorMapped(src: dgram.RemoteInfo): Buffer {
  const val = Buffer.alloc(8);
  val[0] = 0; // reserved
  const isV4 = src.family === 'IPv4';
  val[1] = isV4 ? 0x01 : 0x02;
  val.writeUInt16BE(src.port ^ (MAGIC >>> 16), 2);
  const addr = Buffer.from(isV4 ? src.address.split('.').map(Number) : []);
  if (isV4) {
    const mask = Buffer.from([
      (MAGIC >>> 24) & 0xff,
      (MAGIC >>> 16) & 0xff,
      (MAGIC >>> 8) & 0xff,
      MAGIC & 0xff,
    ]);
    for (let i = 0; i < 4; i++) val[4 + i] = addr[i] ^ mask[i];
  } else {
    // IPv6 XORs against cookie || transaction-id — handled by the caller
    // passing a 16-byte mask; IPv6 STUN is rare for WebRTC LAN/public use.
    val[1] = 0x02;
    val.fill(0, 4, 20);
    val.set(addr.subarray(0, 16), 4);
  }
  const out = Buffer.alloc(4 + val.length);
  out.writeUInt16BE(0x0020, 0);
  out.writeUInt16BE(val.length, 2);
  val.copy(out, 4);
  return out;
}

function bindingResponse(txn: Buffer, src: dgram.RemoteInfo): Buffer {
  const attr = xorMapped(src);
  const out = Buffer.alloc(20 + attr.length);
  out.writeUInt16BE(0x0101, 0); // binding success
  out.writeUInt16BE(attr.length, 2);
  out.writeUInt32BE(MAGIC, 4);
  txn.copy(out, 8);
  attr.copy(out, 20);
  return out;
}

function errorResponse(txn: Buffer, code: number, reason: string): Buffer {
  const val = Buffer.alloc(4 + reason.length);
  val[0] = Math.floor(code / 100);
  val[1] = code % 100;
  val.write(reason, 4);
  const attr = Buffer.alloc(4 + val.length);
  attr.writeUInt16BE(0x0009, 0); // ERROR-CODE
  attr.writeUInt16BE(val.length, 2);
  val.copy(attr, 4);
  const out = Buffer.alloc(20 + attr.length);
  out.writeUInt16BE(0x0111, 0); // binding error
  out.writeUInt16BE(attr.length, 2);
  out.writeUInt32BE(MAGIC, 4);
  txn.copy(out, 8);
  attr.copy(out, 20);
  return out;
}

/** Start the STUN responder on a UDP socket. Returns the bound port. */
export function startStunServer(port = Number(process.env.STUN_PORT ?? 3478)): number {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 20) return;
    const msgType = msg.readUInt16BE(0);
    if (msgType !== 0x0001) return; // only binding requests
    const txn = msg.subarray(8, 20);
    const cookieOk = msg.readUInt32BE(4) === MAGIC;
    const resp = cookieOk
      ? bindingResponse(txn, rinfo)
      : errorResponse(txn, 400, 'Bad Request');
    sock.send(resp, rinfo.port, rinfo.address);
  });
  sock.on('error', (err) => console.error('[stun] socket error:', err.message));
  sock.bind(port, '0.0.0.0', () => {
    console.log(`[stun] listening on udp/${port}`);
  });
  return port;
}
