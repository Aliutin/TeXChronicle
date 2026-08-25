// The Node floor, and the message for being under it.
//
// This lives in bin/ and is written in deliberately old syntax — no `??`, no
// `?.`, no optional catch binding — because bin/cli.mjs static-imports it and
// must still PARSE on the ancient Node it exists to reject. A syntax error here
// is a crash with no explanation, which is the failure this whole file prevents.
//
// It is also the ONLY floor. An earlier attempt put a second copy in
// src/server.ts; that one could never fire, because ESM evaluates every `import`
// before the module body, so on an old Node chokidar or playwright throws first.
// Two floors that disagree are worse than one in the wrong place.

/** Lowest version allowed by an npm `engines` range, as [major, minor, patch]. */
export function floorOf(range) {
  if (typeof range !== 'string') return null;
  // npm accepts far more than `x.y.z`: ">=20.19.0", ">=22", "20.x", "^22",
  // ">=20 <23", "^20.19.0 || >=22". Take the lowest floor across `||` branches,
  // since satisfying any branch satisfies the range.
  var branches = range.split('||');
  var lowest = null;
  for (var i = 0; i < branches.length; i++) {
    var m = branches[i].match(/(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
    if (!m) continue;
    var part = function (s) {
      return s === undefined || s === 'x' || s === '*' ? 0 : Number(s);
    };
    var v = [Number(m[1]), part(m[2]), part(m[3])];
    if (lowest === null || compare(v, lowest) < 0) lowest = v;
  }
  return lowest;
}

function compare(a, b) {
  for (var i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when the running Node is below the floor of `range`. */
export function isBelowFloor(have, range) {
  var floor = floorOf(range);
  var mine = floorOf(have);
  // An unreadable version on either side lets the process start. Refusing to run
  // over a string we failed to parse turns a cosmetic problem into a total one.
  if (!floor || !mine) return false;
  return compare(mine, floor) < 0;
}

export function tooOldMessage(have, floor) {
  var need = floor.join('.');
  return (
    '\n' +
    '✖ TeXChronicle needs Node ' + need + ' or newer — you are running v' + have + '.\n' +
    '\n' +
    '  This is the floor chokidar and playwright actually need. Below it TeXChronicle\n' +
    '  fails while loading them, in ways that never mention Node.\n' +
    '\n' +
    '  Install the current LTS from https://nodejs.org/ — the macOS and Windows\n' +
    '  installers replace your existing Node — then restart your MCP client.\n' +
    '\n' +
    "  Using nvm:  nvm install --lts && nvm alias default 'lts/*'\n" +
    '\n' +
    '  MCP clients launched from a GUI may not see an nvm-managed Node at all; if\n' +
    '  that happens, point the "command" in your MCP config at the absolute path\n' +
    '  from `which node`.\n'
  );
}

/**
 * Write `msg` to stderr and exit with `code`, without losing the message.
 *
 * `console.error` followed by `process.exit` does not wait for the write to
 * drain, and MCP clients spawn this process with piped stdio, where the write is
 * asynchronous. The client then reports a bare non-zero exit with no output —
 * exactly the unexplained failure this check exists to replace.
 */
export function exitWithMessage(msg, code) {
  try {
    process.stderr.write(msg, function () { process.exit(code); });
  } catch (e) {
    process.exit(code);
  }
  // If the callback never fires (a wedged pipe), don't hang forever.
  setTimeout(function () { process.exit(code); }, 2000).unref();
}
