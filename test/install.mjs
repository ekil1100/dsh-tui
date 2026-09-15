import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { startApp } from './support/pty.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');

test('a packed bundle installs, parses help, rejects non-TTY startup, and cold-loads both sessions across /new', async t => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-tui-packed-')));
  const profile = path.join(home, 'profiles/tui');
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native' };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
    if (result.error) throw result.error;
    return result;
  };
  const ok = result => {
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const pack = JSON.parse(ok(run('npm', ['pack', '--json', '--pack-destination', home])))[0];
  const archive = path.join(home, pack.filename);
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'startup' } },
  }));
  // Approve only this local artifact's build script in the isolated test profile.
  writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), JSON.stringify({
    packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false,
    allowBuilds: { [`@ekil9/dsh-tui@file:${path.relative(profile, archive)}`]: true },
  }));
  writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  try {
    ok(run(process.execPath, [bin, 'plugin', '--profile', 'tui', 'add', archive]));
    const manifest = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@ekil9/dsh-tui']);
    const config = ok(run(process.execPath, [bin, '--profile', 'tui', '--dump-config']));
    assert.match(config, /tui-runner/);
    assert.doesNotMatch(config, /name:.*(?:dsh-host|dsh-http-server|dsh-web-app|dsh-web-runtime)/);
    const help = ok(run(process.execPath, [bin, '--profile', 'tui', '--help']));
    assert.match(help, /inline terminal session/);
    assert.doesNotMatch(help, /\x1b\[\?2004h/);
    const badArg = run(process.execPath, [bin, '--profile', 'tui', '--resume', 'no-session']);
    assert.notEqual(badArg.status, 0);
    assert.match(badArg.stderr, /unknown option/);
    const noTty = run(process.execPath, [bin, '--profile', 'tui']);
    assert.notEqual(noTty.status, 0);
    assert.match(noTty.stderr, /interactive TTY/);
    assert.doesNotMatch(noTty.stdout + noTty.stderr, /\x1b\[\?2004h/);
    writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '- id: agent-default-model', '  config:', '    provider: test', '    model: test',
      '- id: session-title-llm', '  disabled: true',
      '- insert:', '    - id: test-model', `      name: ${JSON.stringify(path.join(root, 'test/fixtures/model.mjs'))}`,
    ].join('\n'));
    const app = await startApp(t, { name: 'packed', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(bin)} --profile tui`, env });
    await app.waitFor('dsh · test', 15000);
    await app.input('packed\r');
    await app.waitFor('Reply: packed');
    await app.input('/new\r');
    await app.waitFor('New session:');
    await app.input('fresh-session\r');
    await app.waitFor('Reply: fresh-session');
    await app.input('\x04');
    await app.shellCheck();
    // Cold-read through the public service after the packed process has exited.
    const reader = new Context();
    try {
      await reader.plugin(SessionStore);
      await reader.plugin(JsonlSessionPersistence, { root: path.join(home, 'sessions') });
      const sessions = await reader.sessionPersistence.list();
      assert.equal(sessions.length, 2);
      const logs = [];
      for (const session of sessions) {
        const handle = await reader.sessionPersistence.open(session.header.id, 'read');
        try {
          const log = JSON.stringify((await handle.read()).events);
          assert.match(log, /"kind":"completed"/);
          logs.push(log);
        } finally { await handle.close(); }
      }
      const previous = logs.filter(log => log.includes('Reply: packed'));
      const current = logs.filter(log => log.includes('Reply: fresh-session'));
      assert.equal(previous.length, 1);
      assert.equal(current.length, 1);
      assert.doesNotMatch(previous[0], /Reply: fresh-session/);
      assert.doesNotMatch(current[0], /Reply: packed/);
    } finally { await reader.fiber.dispose(); }
  } finally {
    t.after(() => rmSync(home, { recursive: true, force: true }));
  }
});
