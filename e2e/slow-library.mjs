// A preload for golive-prepare.spec.ts (NODE_OPTIONS=--import): while the file ORDO_E2E_SLOW_GOLIVE_FLAG
// exists, the library process sends its goLive bundles (GET /internal/golive/<id>) slowly: the headers at
// once, then the body in half-second steps over ORDO_E2E_SLOW_GOLIVE_MS, as a busy or slow library does
// (design/29 §2.3 M8). Every other answer, and every answer while the file is absent, is untouched.
import { existsSync } from 'node:fs';
import http from 'node:http';

const flag = process.env.ORDO_E2E_SLOW_GOLIVE_FLAG;
const total = Number(process.env.ORDO_E2E_SLOW_GOLIVE_MS ?? 0);

if (flag && total > 0) {
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, res, ...rest) {
    if (event === 'request' && req?.url?.startsWith('/internal/golive/') && existsSync(flag)) slowly(res);
    return emit.call(this, event, req, res, ...rest);
  };
}

function slowly(res) {
  const end = res.end;
  const write = res.write;
  res.end = (chunk, encoding, done) => {
    const cb = typeof encoding === 'function' ? encoding : done;
    let buf;
    if (chunk == null || typeof chunk === 'function') buf = Buffer.alloc(0);
    else if (Buffer.isBuffer(chunk)) buf = chunk;
    else buf = Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    const steps = Math.max(1, Math.round(total / 500));
    let i = 0;
    const step = () => {
      const from = Math.floor((i * buf.length) / steps);
      const to = Math.floor(((i + 1) * buf.length) / steps);
      i++;
      if (i >= steps) {
        end.call(res, buf.subarray(from, to), cb);
        return;
      }
      write.call(res, buf.subarray(from, to));
      setTimeout(step, total / steps);
    };
    step();
    return res;
  };
}
