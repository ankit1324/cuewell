'use strict';
// .github/workflows/release.yml signs macOS builds with the self-signed
// certificate from the MAC_SELF_SIGN_P12 secret, and stays ad-hoc (with a
// warning) without it. The YAML is parsed, and the import and verify steps'
// scripts run under bash the way GitHub runs them, with stand-ins for
// security, sudo, openssl and codesign that record what they were asked.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { readSource } = require('./helpers/source');

const workflow = yaml.load(readSource('.github/workflows/release.yml'));
const steps = workflow.jobs.build.steps;
const stepNamed = (name) => {
  const step = steps.find((s) => s.name === name);
  assert.ok(step, `no step "${name}"`);
  return step;
};
const indexOf = (name) => steps.indexOf(stepNamed(name));
const IMPORT = 'Import macOS signing certificate';
const VERIFY = 'Verify macOS code signature';
const CLEANUP = 'Remove macOS signing keychain';
const IDENTITY = 'Cuewell Self-Signed';
const SHA1 = '2FC4FDD71B46AC2483062139BF8E304BB09082B3';
const canRunBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;

const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

/** Write an executable stand-in for `name` into `bin`. */
function tool(bin, name, body) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\n${body}\n`, { mode: 0o755 });
}

/** Run one step's script as GitHub does (bash -eo pipefail) with stand-in tools. */
function runStep(step, { env = {}, setup = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuewell-release-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const temp = path.join(root, 'runner-temp');
  fs.mkdirSync(bin);
  fs.mkdirSync(temp);
  const files = { calls: path.join(root, 'calls.log'), output: path.join(root, 'output'), env: path.join(root, 'env') };
  for (const file of Object.values(files)) fs.writeFileSync(file, '');
  setup({ root, bin, temp });
  const script = path.join(root, 'step.sh');
  fs.writeFileSync(script, step.run);
  const child = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: root, CALLS: files.calls, RUNNER_TEMP: temp, GITHUB_OUTPUT: files.output, GITHUB_ENV: files.env,
      ...step.env, ...env,
    },
  });
  const read = (file) => fs.readFileSync(file, 'utf8');
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, calls: read(files.calls).trim().split('\n').filter(Boolean),
    output: read(files.output), env: read(files.env), temp, root };
}

// Stand-ins for the macOS tools the import step uses. `trusted`: whether
// find-identity -v lists the identity after add-trusted-cert.
function signingTools({ trusted = true, certName = IDENTITY } = {}) {
  return ({ bin, root }) => {
    tool(bin, 'sudo', 'exec "$@"');
    tool(bin, 'openssl', 'echo 0123456789abcdef');
    tool(bin, 'security', `
case "$1" in
  list-keychains) [ "$2" = "-d" ] && [ "$#" -eq 3 ] && echo '    "/Users/runner/Library/Keychains/login.keychain-db"' ;;
  import) cp "$2" "${root}/imported.p12" ;;
  find-certificate)
    if [ "$3" = "${certName}" ]; then
      case "$4" in -Z) echo "SHA-256 hash: 00"; echo "SHA-1 hash: ${SHA1}" ;; -p) echo "-----BEGIN CERTIFICATE-----" ;; esac
    fi ;;
  find-identity)
    if [ "$2" = "-v" ] && [ "${trusted ? 1 : 0}" = 1 ]; then echo '  1) ${SHA1} "${IDENTITY}"'; echo '     1 valid identities found'; fi ;;
esac
exit 0`);
  };
}

describe('release workflow (macOS signing)', () => {
  it('parses, and keeps the read-only default permissions', () => {
    assert.equal(workflow.name, 'Build & Release');
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.ok(Array.isArray(steps) && steps.length > 5);
  });

  it('imports the certificate on macOS only, before the build, and cleans up after it', () => {
    const step = stepNamed(IMPORT);
    assert.equal(step.id, 'mac-sign');
    assert.equal(step.if, "matrix.whisper_platform == 'darwin'");
    assert.ok(indexOf(IMPORT) < indexOf('Build'));
    assert.ok(indexOf(CLEANUP) > indexOf('Build'));
    assert.equal(stepNamed(CLEANUP).if, "always() && matrix.whisper_platform == 'darwin'");
    assert.ok(indexOf(VERIFY) > indexOf('Build'));
    assert.equal(stepNamed(VERIFY).if, "matrix.whisper_platform == 'darwin'");
  });

  it('gives the secrets to the import step only, never to the build', () => {
    assert.deepEqual(stepNamed(IMPORT).env, {
      MAC_SELF_SIGN_P12: '${{ secrets.MAC_SELF_SIGN_P12 }}',
      MAC_SELF_SIGN_PASSWORD: '${{ secrets.MAC_SELF_SIGN_PASSWORD }}',
      IDENTITY,
    });
    for (const step of steps.filter((s) => s.name !== IMPORT)) {
      assert.doesNotMatch(JSON.stringify(step), /secrets\./, step.name);
    }
    const build = stepNamed('Build');
    assert.deepEqual(build.env, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
    assert.doesNotMatch(build.run, /CSC_LINK|CSC_NAME|secrets/);
  });

  it('runs no ${{ }} expressions inside the signing scripts', () => {
    for (const name of [IMPORT, VERIFY, CLEANUP]) assert.doesNotMatch(stepNamed(name).run, /\$\{\{/, name);
  });

  describe('import step', { skip: !canRunBash && 'needs bash' }, () => {
    it('without the secret: warns, stays ad-hoc, and touches no keychain', () => {
      const run = runStep(stepNamed(IMPORT), { env: { MAC_SELF_SIGN_P12: '', MAC_SELF_SIGN_PASSWORD: '' }, setup: signingTools() });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /^::warning::MAC_SELF_SIGN_P12 is not set/m);
      assert.equal(run.output, 'signed=false\n');
      assert.equal(run.env, '', 'set CSC_* without a certificate');
      assert.deepEqual(run.calls, []);
    });

    it('with the secret: imports into a temporary keychain, trusts it for signing, and hands electron-builder the identity', () => {
      const p12 = Buffer.from([0x30, 0x82, 0x0d, 0x1c, 0xff, 0x00, 0x7f, 0x80]);
      // Pasted with line breaks, as a wrapped base64 value can be.
      const secret = p12.toString('base64').replace(/(.{4})/g, '$1\n');
      const run = runStep(stepNamed(IMPORT), {
        env: { MAC_SELF_SIGN_P12: secret, MAC_SELF_SIGN_PASSWORD: 'pw' },
        setup: signingTools(),
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const keychain = path.join(run.temp, 'cuewell-signing.keychain-db');
      assert.equal(run.env, `CSC_NAME=${IDENTITY}\nCSC_KEYCHAIN=${keychain}\n`);
      assert.equal(run.output, `cert_sha1=${SHA1}\nsigned=true\n`);
      assert.deepEqual(fs.readFileSync(path.join(run.root, 'imported.p12')), p12, 'decoded the secret');
      assert.ok(!fs.existsSync(path.join(run.temp, 'cuewell-signing.p12')), 'left the .p12 on disk');
      const calls = run.calls.join('\n');
      assert.match(calls, new RegExp(`^security create-keychain -p \\S+ ${keychain}$`, 'm'));
      assert.match(calls, new RegExp(`^security import \\S+ -k ${keychain} -P pw -T /usr/bin/codesign$`, 'm'));
      assert.match(calls, /^security set-key-partition-list -S apple-tool:,apple: -s -k \S+ \S+$/m);
      assert.match(calls, /^sudo security add-trusted-cert -d -r trustRoot -p codeSign /m);
      assert.match(calls, new RegExp(`^security list-keychains -d user -s ${keychain} /Users/runner/Library/Keychains/login.keychain-db$`, 'm'));
    });

    it('fails instead of building ad-hoc when the identity is not valid for signing', () => {
      const run = runStep(stepNamed(IMPORT), {
        env: { MAC_SELF_SIGN_P12: 'AAAA', MAC_SELF_SIGN_PASSWORD: 'pw' },
        setup: signingTools({ trusted: false }),
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stdout, /::error::"Cuewell Self-Signed" is not a valid code-signing identity/);
      assert.equal(run.env, '');
      assert.doesNotMatch(run.output, /signed=true/);
    });

    it('fails when the .p12 holds another certificate', () => {
      const run = runStep(stepNamed(IMPORT), {
        env: { MAC_SELF_SIGN_P12: 'AAAA', MAC_SELF_SIGN_PASSWORD: 'pw' },
        setup: signingTools({ certName: 'Someone Else' }),
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stdout, /::error::MAC_SELF_SIGN_P12 holds no certificate named/);
      assert.equal(run.env, '');
    });
  });

  describe('verify step', { skip: !canRunBash && 'needs bash' }, () => {
    const signedBy = (hash, { server = hash } = {}) => ({ bin, root }) => {
      for (const dir of ['mac', 'mac-arm64']) {
        fs.mkdirSync(path.join(root, 'dist', dir, 'Cuewell.app', 'Contents', 'Resources', 'whisper'), { recursive: true });
      }
      tool(bin, 'codesign', `
for last; do :; done
if [ "$1" = "-d" ]; then
  case "$last" in
    *whisper-server) echo "designated => identifier \\"whisper-server\\" and certificate leaf = H\\"${server}\\"" ;;
    *) echo "Executable=$last" >&2; echo "designated => ${hash.startsWith('cdhash') ? hash : `identifier \\"com.ankitchaudhary.cuewell\\" and certificate leaf = H\\"${hash}\\"`}" ;;
  esac
fi
exit 0`);
    };

    it('passes when both apps and their whisper-server carry the certificate', () => {
      const run = runStep(stepNamed(VERIFY), { env: { SIGNED: 'true', CERT_SHA1: SHA1 }, setup: signedBy(SHA1.toLowerCase()) });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(run.calls.filter((c) => /^codesign --verify --deep --strict/.test(c)).length, 2);
      assert.equal(run.calls.filter((c) => /^codesign --verify --strict .*whisper-server$/.test(c)).length, 2);
    });

    it('fails for an app signed with another certificate, or an unsigned whisper-server', () => {
      let run = runStep(stepNamed(VERIFY), { env: { SIGNED: 'true', CERT_SHA1: SHA1 }, setup: signedBy('1111111111111111111111111111111111111111') });
      assert.notEqual(run.status, 0);
      assert.match(run.stdout, /::error::.*is not signed with the certificate/);
      run = runStep(stepNamed(VERIFY), {
        env: { SIGNED: 'true', CERT_SHA1: SHA1 },
        setup: signedBy(SHA1.toLowerCase(), { server: 'ffff' }),
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stdout, /::error::.*whisper-server is not signed with the certificate/);
    });

    it('only warns for ad-hoc builds when there was no secret', () => {
      const run = runStep(stepNamed(VERIFY), { env: { SIGNED: 'false', CERT_SHA1: '' }, setup: signedBy('cdhash H"96d1"') });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal((run.stdout.match(/::warning::.*ad-hoc signed/g) || []).length, 2);
    });

    it('fails when there is no app to check', () => {
      const run = runStep(stepNamed(VERIFY), { env: { SIGNED: 'true', CERT_SHA1: SHA1 }, setup: ({ bin }) => tool(bin, 'codesign', 'exit 0') });
      assert.notEqual(run.status, 0);
      assert.match(run.stdout, /::error::No Cuewell\.app in dist/);
    });
  });
});

describe('make-self-signed-cert.sh', () => {
  const script = readSource('scripts/make-self-signed-cert.sh');

  it('makes a 10-year code-signing certificate named "Cuewell Self-Signed"', () => {
    assert.match(script, /^NAME="Cuewell Self-Signed"$/m);
    assert.match(script, /^DAYS=3650$/m);
    assert.match(script, /extendedKeyUsage = critical, codeSigning/);
    assert.match(script, /keyUsage = critical, digitalSignature/);
    assert.match(script, /-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1/);
  });

  it('refuses to write the key into the repository or over an existing one', () => {
    assert.match(script, /is inside the repository/);
    assert.match(script, /already exists\. Reuse that certificate/);
  });

  it('is executable and has valid bash syntax', { skip: !canRunBash && 'needs bash' }, () => {
    const file = path.join(__dirname, '..', 'scripts', 'make-self-signed-cert.sh');
    assert.ok(fs.statSync(file).mode & 0o100, 'not executable');
    const check = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  });
});
