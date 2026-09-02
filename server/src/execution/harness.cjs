// PIE — JavaScript test harness. Runs INSIDE the sandbox, never on the server.
// Same contract as harness.py: read one JSON file, print one JSON line.
//
// .cjs on purpose: PIE's server package is an ES module, and this file is
// CommonJS. Inside the sandbox it is run by plain `node harness.cjs`.
const fs = require('fs');

function main() {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const results = [];

  // Capture anything the candidate prints, so it cannot be mixed into — or
  // forge — the result line this harness writes.
  const realLog = console.log;
  let buf = '';
  console.log = (...a) => { buf += a.map(String).join(' ') + '\n'; };
  const say = obj => { console.log = realLog; realLog(JSON.stringify(obj)); };

  let fn;
  try {
    const module = { exports: {} };
    // eslint-disable-next-line no-new-func
    const load = new Function('module', 'exports', `${spec.code}\n;return typeof ${spec.entryPoint} === 'function' ? ${spec.entryPoint} : (module.exports.${spec.entryPoint} || module.exports);`);
    fn = load(module, module.exports);
  } catch (e) {
    return say({ ok: false, error: `${e.name}: ${e.message}`, results: [] });
  }
  if (typeof fn !== 'function') {
    return say({ ok: false, error: `No function named '${spec.entryPoint}' was defined.`, results: [] });
  }

  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const t of spec.tests) {
    buf = '';
    try {
      const got = fn(...(t.input || []));
      results.push({ id: t.id, passed: eq(got, t.expected),
        got: JSON.stringify(got)?.slice(0, 400) ?? String(got), stdout: buf.slice(0, 400) });
    } catch (e) {
      results.push({ id: t.id, passed: false, error: `${e.name}: ${e.message}`, stdout: buf.slice(0, 400) });
    }
  }
  say({ ok: true, error: null, results });
}
main();
