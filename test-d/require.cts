// A CommonJS module. Node.js 20.19+ and 22.12+ can require() the package, an ES module.
import http from "node:http";
import PeekInside from "peekinside";
import peekinside = require("peekinside");

const attached: PeekInside = PeekInside.attach(http.createServer());
const created: PeekInside = new peekinside.default({ local: false });
void attached.flush().then(() => created.stop());
