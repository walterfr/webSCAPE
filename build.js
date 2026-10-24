/**
 * Script de Build & Empacotamento .ipk para LG webOS 5.6.2 (Developer Mode)
 * - Valida ícones webSCAPE (80x80 / 130x130) em app/assets (master 512px em branding/)
 * - Compila o Background JS Service + Sucrase em bundle único para Node.js 8.12 (--target=node8)
 * - Empacota app + service em arquivo .ipk instalável via ares-install
 */
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var esbuild = require('esbuild');

var ROOT = __dirname;
var DIST_DIR = path.join(ROOT, 'dist');
var DIST_APP = path.join(DIST_DIR, 'app');
var DIST_SVC = path.join(DIST_DIR, 'service');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  var entries = fs.readdirSync(src, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var srcPath = path.join(src, entry.name);
    var destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function runBuild() {
  console.log('1. Verificando ícones webSCAPE (80x80 e 130x130)...');
  ['icon80.png', 'icon130.png'].forEach(function (f) {
    if (!fs.existsSync(path.join(ROOT, 'app', 'assets', f))) {
      throw new Error('Ícone ausente: app/assets/' + f);
    }
  });

  console.log('2. Preparando diretório dist/...');
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_APP, { recursive: true });
  fs.mkdirSync(DIST_SVC, { recursive: true });

  copyDirRecursive(path.join(ROOT, 'app'), DIST_APP);
  fs.copyFileSync(path.join(ROOT, 'service', 'services.json'), path.join(DIST_SVC, 'services.json'));
  fs.copyFileSync(path.join(ROOT, 'service', 'package.json'), path.join(DIST_SVC, 'package.json'));
  copyDirRecursive(
    path.join(ROOT, 'service', 'src', 'client-injected'),
    path.join(DIST_SVC, 'client-injected')
  );

  console.log('3. Compilando JS Service (Sucrase + Proxy) para Node.js 8.12.0 (webOS 5.6.2)...');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'service', 'src', 'index.js')],
    bundle: true,
    platform: 'node',
    target: ['node8.12'],
    format: 'cjs',
    external: ['webos-service'],
    outfile: path.join(DIST_SVC, 'service.bundle.js'),
    minify: false
  });

  console.log('   Bundle criado:', path.join(DIST_SVC, 'service.bundle.js'));

  if (process.argv.indexOf('--ipk') !== -1) {
    console.log('4. Empacotando arquivo .ipk via ares-package...');
    var cmd = 'npx ares-package "' + DIST_APP + '" "' + DIST_SVC + '" -o "' + DIST_DIR + '"';
    var out = childProcess.execSync(cmd, { encoding: 'utf8' });
    console.log(out.trim());
  }
}

runBuild().catch(function (err) {
  console.error('Erro no build:', err);
  process.exit(1);
});
