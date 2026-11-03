// Regenerates src/pro7-descriptor.json from the vendored ProPresenter 7 .proto files.
// Usage: node packages/importers/scripts/gen-proto-json.cjs
const path = require('node:path');
const fs = require('node:fs');
const protobuf = require('protobufjs');

const protoDir = path.join(__dirname, '..', 'proto');
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => {
  const local = path.join(protoDir, target);
  return fs.existsSync(local) ? local : target;
};
root.loadSync(path.join(protoDir, 'propresenter.proto'), { keepCase: false });
root.resolveAll();
const version = fs.readFileSync(path.join(protoDir, 'VERSION'), 'utf8').trim();
const out = { version: `greyshirtguy/ProPresenter7-Proto@${version.slice(0, 12)}`, root: root.toJSON() };
fs.writeFileSync(path.join(__dirname, '..', 'src', 'pro7-descriptor.json'), JSON.stringify(out));
console.log('wrote descriptor', out.version);
