import dgram from "node:dgram";
import net from "node:net";

function blocked() {
  const error = new Error("NETWORK_BLOCKED");
  error.code = "NETWORK_BLOCKED";
  throw error;
}

globalThis.fetch = blocked;
net.Socket.prototype.connect = blocked;
net.Server.prototype.listen = blocked;
dgram.Socket.prototype.bind = blocked;
dgram.Socket.prototype.connect = blocked;
dgram.Socket.prototype.send = blocked;
globalThis.__YTSHORTS_NETWORK_GUARD__ = true;
