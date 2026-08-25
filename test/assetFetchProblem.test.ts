import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetFetchProblem } from '../ui/src/api.js';

const NOT_FOUND = "PDF not found using this TeX project's figure paths";

test('a missing figure and a broken server are told apart', () => {
  // The whole point: these two sentences send the reader to different places.
  // Every failure used to produce the first one, so a server that threw on the
  // way to a file that was exactly where it should be had people rewriting
  // \graphicspath and moving figures around for a problem they could not fix.
  assert.equal(assetFetchProblem(404, 'not found', NOT_FOUND), NOT_FOUND);

  const broken = assetFetchProblem(500, 'EBUSY: resource busy or locked', NOT_FOUND);
  assert.match(broken, /500/);
  assert.match(broken, /EBUSY/);
  assert.notEqual(broken, NOT_FOUND);

  // A refusal with nothing to say still says which status it was.
  assert.match(assetFetchProblem(403, '', NOT_FOUND), /403/);
  // Leading blank lines in a server's body are not the message.
  assert.match(assetFetchProblem(500, '\n\n  the real reason\nmore\n', NOT_FOUND), /the real reason/);
  // A page of HTML from something upstream cannot push the pane wide.
  assert.ok(assetFetchProblem(502, 'x'.repeat(5000), NOT_FOUND).length < 300);
});
