/** Verifies the shared terminal question's TTY rule and three distinct outcomes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { askYesNo, isInteractive } from '../../cli/terminal-question.mjs';

function streams(terminal = false) {
  const stdin = new PassThrough();
  const promptOutput = new PassThrough();
  let output = '';
  promptOutput.on('data', (chunk) => { output += chunk.toString(); });
  if (terminal) {
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    promptOutput.isTTY = true;
  }
  return { stdin, promptOutput, readOutput: () => output };
}

test('isInteractive honors the single isTTY override, then falls back to stdin', () => {
  assert.equal(isInteractive({ isTTY: false, stdin: { isTTY: true } }), false);
  assert.equal(isInteractive({ isTTY: true, stdin: { isTTY: false } }), true);
  assert.equal(isInteractive({ stdin: { isTTY: true } }), true);
  assert.equal(isInteractive({ stdin: { isTTY: false } }), false);
});

test('prompt seam maps yes, no, and cancel without printing', async () => {
  for (const [answer, expected] of [
    [true, 'yes'],
    ['y', 'yes'],
    ['YES', 'yes'],
    [false, 'no'],
    ['', 'no'],
    ['cancel', 'cancel'],
  ]) {
    let asked;
    const result = await askYesNo('Keep going?', {
      prompt: (question) => { asked = question; return answer; },
    });
    assert.equal(result, expected, String(answer));
    assert.equal(asked, 'Keep going?');
  }
});

test('readline accepts y and prints the caller question with its suffix', async (t) => {
  const { stdin, promptOutput, readOutput } = streams();
  t.after(() => { stdin.destroy(); promptOutput.destroy(); });
  const resultPromise = askYesNo('Continue?', { stdin, promptOutput });
  stdin.end('y\n');

  assert.equal(await resultPromise, 'yes');
  assert.match(readOutput(), /Continue\? \[y\/N\] /);
});

test('readline maps n and EOF without an answer to no', async (t) => {
  const answered = streams();
  const ended = streams();
  t.after(() => {
    answered.stdin.destroy(); answered.promptOutput.destroy();
    ended.stdin.destroy(); ended.promptOutput.destroy();
  });
  const answerPromise = askYesNo('Continue?', answered);
  answered.stdin.end('n\n');
  const eofPromise = askYesNo('Continue?', ended);
  ended.stdin.end();

  assert.equal(await answerPromise, 'no');
  assert.equal(await eofPromise, 'no');
});

test('readline maps TTY Ctrl+C to cancel', async (t) => {
  const { stdin, promptOutput } = streams(true);
  t.after(() => { stdin.destroy(); promptOutput.destroy(); });
  const resultPromise = askYesNo('Continue?', { stdin, promptOutput });
  stdin.write('\x03');

  assert.equal(await resultPromise, 'cancel');
});
