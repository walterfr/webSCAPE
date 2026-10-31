/**
 * Suite de Verificação End-to-End do Navegador Moderno webOS 5.6.2
 * Testa:
 * 1. Transpilador JS (?. / ?? / ??= / ||= / #private / class fields / 1_000_000)
 * 2. Transformador CSS (inset / clamp / :where / url rewrite)
 * 3. HTML Rewriter + AdBlock (remoção de CSP/integrity, bloqueio de ads, injeção de polyfills)
 * 4. Proxy Reverso HTTP E2E (remoção de X-Frame-Options/CSP e transpilação em tempo real)
 */
'use strict';

var assert = require('assert');
var http = require('http');
var vm = require('vm');
var fs = require('fs');
var path = require('path');

var transpiler = require('../service/src/transpiler');
var htmlRewriter = require('../service/src/html-rewriter');
var adblock = require('../service/src/adblock');
var proxyModule = require('../service/src/proxy');
var originMap = require('../service/src/origin-map');

async function runTests() {
  console.log('--- [1/7] Testando Polyfills Chromium 68 ---');
  var polyfillCode = fs.readFileSync(
    path.join(__dirname, '../service/src/client-injected/polyfills-chrome68.js'),
    'utf8'
  );
  var sandbox = {
    Object: Object,
    Array: Array,
    String: String,
    Promise: Promise,
    Map: Map,
    Set: Set,
    Date: Date,
    RegExp: RegExp,
    Error: Error,
    TypeError: TypeError,
    RangeError: RangeError,
    Math: Math,
    Number: Number,
    Symbol: Symbol,
    JSON: JSON,
    setTimeout: setTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(polyfillCode, sandbox);
  var polyRes = vm.runInContext(
    'JSON.stringify({' +
      'flat: [1, [2, [3]]].flat(2),' +
      'at: [10, 20, 30].at(-1),' +
      'hasOwn: Object.hasOwn({ a: 1 }, "a"),' +
      'fromEntries: Object.fromEntries([["k", "v"]]),' +
      'replaceAll: "a-b-a".replaceAll("a", "z"),' +
      'toSorted: [3, 1, 2].toSorted()' +
    '})',
    sandbox
  );
  var parsedPoly = JSON.parse(polyRes);
  assert.deepStrictEqual(parsedPoly.flat, [1, 2, 3]);
  assert.strictEqual(parsedPoly.at, 30);
  assert.strictEqual(parsedPoly.hasOwn, true);
  assert.strictEqual(parsedPoly.fromEntries.k, 'v');
  assert.strictEqual(parsedPoly.replaceAll, 'z-b-z');
  assert.deepStrictEqual(parsedPoly.toSorted, [1, 2, 3]);
  console.log('   OK: Polyfills Chrome 68 validados.');

  console.log('--- [2/7] Testando Transpilador JS (ES2024 -> Chrome 68) ---');
  var modernJS = [
    'class Counter {',
    '  base = 1_000;',
    '  #secret = 42;',
    '  compute(input) {',
    '    let x = input?.nested?.value ?? 10;',
    '    x ??= 5;',
    '    x ||= 20;',
    '    const hasPriv = #secret in this;',
    '    return hasPriv ? (this.base + this.#secret + x) : 0;',
    '  }',
    '}',
    'globalResult = new Counter().compute({ nested: {} });'
  ].join('\n');

  var transpiled = transpiler.transpileJS(modernJS, 'https://example.com/app.js');
  assert.strictEqual(transpiled.indexOf('?.'), -1, 'Não deve restar optional chaining ?.');
  assert.strictEqual(transpiled.indexOf('??'), -1, 'Não deve restar nullish coalescing ??');
  assert.strictEqual(transpiled.indexOf('#secret'), -1, 'Não deve restar private field #secret');

  var execCtx = { globalResult: 0 };
  vm.createContext(execCtx);
  vm.runInContext(transpiled, execCtx);
  assert.strictEqual(execCtx.globalResult, 1052, 'Resultado da execução do código transpilado deve ser 1052');
  console.log('   OK: Sintaxe ES2024 transpilada e executada com sucesso (resultado = ' + execCtx.globalResult + ').');

  console.log('--- [3/7] Testando Transformador CSS (inset / clamp / :where) ---');
  var modernCSS = '.modal { position: fixed; inset: 10px 20px; font-size: clamp(14px, 18px, 24px); background: url("/bg.png"); } :where(.btn) { color: red; }';
  var fixedCSS = transpiler.transpileCSS(modernCSS, 'https://site.com/css/main.css', 'http://127.0.0.1:8899');
  assert(fixedCSS.indexOf('top:10px;right:20px;bottom:10px;left:20px') !== -1, 'inset deve virar top/right/bottom/left');
  assert(fixedCSS.indexOf('font-size: 18px') !== -1, 'clamp deve usar valor preferido');
  assert(fixedCSS.indexOf(':where') === -1, ':where deve ser simplificado');
  assert(fixedCSS.indexOf(originMap.getProxyBaseForUrl('https://site.com/bg.png', 'http://127.0.0.1:8899') + '/proxy?url=') !== -1, 'url() relativo deve apontar para o proxy');
  console.log('   OK: CSS moderno convertido para Chrome 68.');

  console.log('--- [4/7] Testando HTML Rewriter & AdBlock ---');
  var sampleHTML = [
    '<!DOCTYPE html><html><head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">',
    '<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>',
    '<script src="/static/chunk.js" integrity="sha384-abc"></script>',
    '<script>const a = window?.foo ?? "bar";</script>',
    '</head><body><h1>Teste</h1></body></html>'
  ].join('\n');

  var rewritten = htmlRewriter.rewriteHTML(sampleHTML, 'https://portal.com/noticias', 'http://127.0.0.1:8899');
  assert(rewritten.indexOf('Content-Security-Policy') === -1, 'Meta CSP deve ser removida');
  assert(rewritten.indexOf('blocked ad script') !== -1, 'Script do Google Ads deve ser bloqueado');
  assert(rewritten.indexOf('integrity=') === -1, 'Atributo integrity deve ser removido');
  assert(rewritten.indexOf('/client/polyfills-chrome68.js') !== -1, 'Polyfills devem ser injetados');
  assert(rewritten.indexOf('_nullishCoalesce') !== -1, 'Script inline deve ser transpilado');
  console.log('   OK: HTML Rewriter e AdBlock funcionando.');

  console.log('--- [5/7] Testando envio de formulários pelo proxy ---');
  var submitListener;
  var proxiedLocation = {
    href: 'http://127.0.0.1:8899/proxy?url=' +
      encodeURIComponent('https://www.youtube.com/results') + '&type=doc',
    origin: 'http://127.0.0.1:8899'
  };
  var hookWindow = {
    __WEBOS_PROXY_BASE__: 'http://127.0.0.1:8899',
    __WEBOS_PROXY_TARGET__: 'https://www.youtube.com',
    location: proxiedLocation,
    parent: { postMessage: function () {} },
    addEventListener: function () {}
  };
  var hookDocument = {
    title: 'YouTube',
    addEventListener: function (name, listener) {
      if (name === 'submit') submitListener = listener;
    },
    querySelectorAll: function () { return []; }
  };
  var hookSandbox = { window: hookWindow, document: hookDocument, URL: URL };
  vm.createContext(hookSandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../service/src/client-injected/proxy-hook.js'), 'utf8'),
    hookSandbox
  );

  var form = {
    tagName: 'FORM',
    method: 'get',
    action: proxiedLocation.href,
    getAttribute: function () { return this.action; },
    elements: [
      { name: 'search_query', type: 'text', value: 'webOS TV & navegador' },
      { name: 'sp', type: 'hidden', value: 'EgIQAQ==' },
      { name: 'ignored', type: 'checkbox', value: '1', checked: false }
    ]
  };
  var submitPrevented = false;
  submitListener({
    target: form,
    preventDefault: function () { submitPrevented = true; }
  });

  assert.strictEqual(submitPrevented, true, 'Busca GET deve ser interceptada antes de substituir os parâmetros do proxy');
  var searchProxyUrl = new URL(proxiedLocation.href);
  var searchTarget = new URL(searchProxyUrl.searchParams.get('url'));
  assert.strictEqual(searchTarget.origin, 'https://www.youtube.com');
  assert.strictEqual(searchTarget.pathname, '/results');
  assert.strictEqual(searchTarget.searchParams.get('search_query'), 'webOS TV & navegador');
  assert.strictEqual(searchTarget.searchParams.get('sp'), 'EgIQAQ==');
  console.log('   OK: Campos da busca foram acrescentados à URL original do YouTube dentro do proxy.');

  console.log('--- [6/7] Testando Servidor Proxy Reverso E2E ---');
  await new Promise(function (resolve, reject) {
    // Servidor mock simulando um site moderno com X-Frame-Options: DENY
    var upstream = http.createServer(function (req, res) {
      if (req.url === '/headers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          origin: req.headers.origin || '',
          referer: req.headers.referer || ''
        }));
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'"
      });
      res.end('<html><head></head><body><script>const status = { ok: true }?.ok ?? false;</script></body></html>');
    });

    upstream.listen(0, '127.0.0.1', function () {
      var upPort = upstream.address().port;
      var proxyInst = proxyModule.createProxyServer(18899, '127.0.0.1', { allowLocalTargets: true });
      proxyInst.start(function (err) {
        if (err) return reject(err);

        var target = 'http://127.0.0.1:' + upPort + '/index.html';
        var docProxyBase = originMap.getProxyBaseForUrl(target, 'http://127.0.0.1:18899');
        var docHost = new (require('url').URL)(docProxyBase).host;
        http.get('http://127.0.0.1:18899/proxy?url=' + encodeURIComponent(target) + '&type=doc', { headers: { Host: docHost } }, function (res) {
          assert.strictEqual(res.headers['x-frame-options'], undefined, 'X-Frame-Options deve ser removido pelo proxy');
          assert.strictEqual(res.headers['content-security-policy'], undefined, 'CSP deve ser removido pelo proxy');

          var body = '';
          res.on('data', function (c) { body += c; });
          res.on('end', function () {
            assert(body.indexOf('_optionalChain') !== -1, 'HTML retornado pelo proxy deve ter JS transpilado');
            var sourcePage = 'https://m.youtube.com/watch?v=abc';
            var browserReferer = 'http://127.0.0.1:18899/proxy?url=' +
              encodeURIComponent(sourcePage) + '&type=doc';
            var apiTarget = 'http://127.0.0.1:' + upPort + '/headers';
            var apiProxyBase = originMap.getProxyBaseForUrl(apiTarget, 'http://127.0.0.1:18899');
            var apiHost = new (require('url').URL)(apiProxyBase).host;
            var headersUrl = 'http://127.0.0.1:18899/proxy?url=' +
              encodeURIComponent(apiTarget) + '&type=xhr';

            console.log('--- [7/7] Testando cabeçalhos de origem no Proxy ---');
            http.get(headersUrl, {
              headers: {
                Host: apiHost,
                Origin: 'http://127.0.0.1:18899',
                Referer: browserReferer
              }
            }, function (headersRes) {
              var headersBody = '';
              headersRes.on('data', function (c) { headersBody += c; });
              headersRes.on('end', function () {
                try {
                  var forwarded = JSON.parse(headersBody);
                  assert.strictEqual(forwarded.origin, 'https://m.youtube.com',
                    'Origin encaminhado deve usar a origem real da página');
                  assert.strictEqual(forwarded.referer, sourcePage,
                    'Referer encaminhado deve usar a URL real da página');
                  proxyInst.server.close();
                  upstream.close();
                  console.log('   OK: Proxy removeu bloqueios, transpilou HTML e preservou Origin/Referer reais.');
                  resolve();
                } catch (err) {
                  proxyInst.server.close();
                  upstream.close();
                  reject(err);
                }
              });
            }).on('error', function (err) {
              proxyInst.server.close();
              upstream.close();
              reject(err);
            });
          });
        }).on('error', reject);
      });
    });
  });

  console.log('\nTODOS OS TESTES PASSARAM COM SUCESSO!');
}

runTests().catch(function (err) {
  console.error('FALHA NOS TESTES:', err);
  process.exit(1);
});
