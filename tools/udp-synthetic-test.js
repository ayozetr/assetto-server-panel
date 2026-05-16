#!/usr/bin/env node
// Synthetic UDP plugin emitter — sends a sequence of Kunos-spec packets to
// the running dashboard so we can verify the parser end-to-end without a
// live acServer. Pair with PORT=3001 dashboard listening with the UDP plugin
// enabled (UDP_PLUGIN_ADDRESS=127.0.0.1:12001 / UDP_PLUGIN_LOCAL_PORT=12000).

const dgram = require('dgram');
const sock  = dgram.createSocket('udp4');
const HOST  = '127.0.0.1';
const PORT  = parseInt(process.argv[2], 10) || 12001;

function utf8Str(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([b.length]), b]);
}
function utf32Str(s) {
  const chars = Array.from(s);
  const b = Buffer.alloc(1 + chars.length * 4);
  b[0] = chars.length;
  for (let i = 0; i < chars.length; i++) b.writeUInt32LE(chars[i].codePointAt(0), 1 + i * 4);
  return b;
}
function u8 (n) { return Buffer.from([n & 0xff]); }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32LE(n);  return b; }
function f32(n) { const b = Buffer.alloc(4); b.writeFloatLE(n);  return b; }

function newSessionPkt() {
  return Buffer.concat([
    u8(50),               // ACSP_NEW_SESSION
    u8(4),                // protocol version
    u8(0), u8(0), u8(3),  // session_index, current_index, session_count
    utf32Str('Test Server'),
    utf8Str('ks_red_bull_ring'),
    utf8Str('layout_gp'),
    utf8Str('Practice'),
    u8(1),                // type=PRACTICE
    u16(180),             // time=180 min
    u16(0),               // laps
    u16(60),              // wait_time
    u8(22),               // ambient_temp
    u8(28),               // road_temp
    utf8Str('3_clear'),
    i32(0),               // elapsed_ms (session just started)
  ]);
}

function newConnectionPkt(carId, name, guid, model) {
  return Buffer.concat([
    u8(51),               // ACSP_NEW_CONNECTION
    utf32Str(name),
    utf32Str(''),         // team
    utf32Str(guid),
    u8(carId),
    utf8Str(model),
    utf8Str('Base'),
  ]);
}

function lapCompletedPkt(carId, lapTimeMs, cuts, lapsTotal) {
  // Leaderboard with a single entry for our car
  const lb = Buffer.concat([
    u8(carId), u32(lapTimeMs), u16(lapsTotal), u8(1),
  ]);
  return Buffer.concat([
    u8(73),               // ACSP_LAP_COMPLETED
    u8(carId),
    u32(lapTimeMs),
    u8(cuts),
    u8(1),                // cars count in leaderboard
    lb,
    f32(0.99),            // grip level
  ]);
}

function connectionClosedPkt(carId, name, guid, model) {
  return Buffer.concat([
    u8(52),               // ACSP_CONNECTION_CLOSED
    utf32Str(name), utf32Str(''), utf32Str(guid),
    u8(carId), utf8Str(model), utf8Str('Base'),
  ]);
}

function send(pkt, tag) {
  sock.send(pkt, PORT, HOST, (err) => {
    if (err) console.error(`ERR ${tag}:`, err.message);
    else     console.log(`sent ${tag} (${pkt.length} bytes)`);
  });
}

// Two placeholder drivers exercising the parser end-to-end. Names and Steam
// GUIDs here are obvious fakes (the trailing-zero block on the GUIDs gives
// it away) so the script is safe to publish without leaking real player PII.
// If you fork this for your own integration testing, keep the placeholder
// pattern — never paste live Steam IDs into a file that lands in version
// control.
(async () => {
  send(newSessionPkt(), 'NEW_SESSION');
  await new Promise(r => setTimeout(r, 200));
  send(newConnectionPkt(0, 'DriverOne', '76561198000000001', 'ks_toyota_ae86'), 'JOIN DriverOne');
  await new Promise(r => setTimeout(r, 200));
  send(newConnectionPkt(1, 'DriverTwo', '76561198000000002', 'ks_toyota_ae86'), 'JOIN DriverTwo');
  await new Promise(r => setTimeout(r, 400));
  send(lapCompletedPkt(0, 250217, 0, 1), 'LAP DriverOne 4:10.217');
  await new Promise(r => setTimeout(r, 200));
  send(lapCompletedPkt(1, 288071, 0, 1), 'LAP DriverTwo 4:48.071');
  await new Promise(r => setTimeout(r, 200));
  send(lapCompletedPkt(1, 277298, 0, 2), 'LAP DriverTwo 4:37.298');
  await new Promise(r => setTimeout(r, 200));
  send(lapCompletedPkt(1, 277298, 0, 2), 'LAP DriverTwo 4:37.298 (DUPLICATE — should not double-insert)');
  await new Promise(r => setTimeout(r, 300));
  send(connectionClosedPkt(0, 'DriverOne', '76561198000000001', 'ks_toyota_ae86'), 'LEAVE DriverOne');
  await new Promise(r => setTimeout(r, 300));
  sock.close();
})();
