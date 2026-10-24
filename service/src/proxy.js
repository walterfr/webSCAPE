/**
 * Servidor Proxy Reverso Transpilador para LG webOS 5.6.2
 * Compatível com Node.js 8.12.0 (usa apenas http/https/zlib/url nativos).
 * - Usa Accept-Encoding: gzip, deflate (Node 8.12 não possui Brotli nativo)
 * - Ignora erro de Root CA expirado do firmware antigo da TV (Let's Encrypt ISRG Root)
 * - Remove X-Frame-Options e CSP
 * - Transpila HTML, JS (ES2024 -> Chrome 68) e CSS em tempo real
 */
'use strict';

var http = require('http');
var https = require('https');
var urlModule = require('url');
var URL = global.URL || urlModule.URL;
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');

var transpiler = require('./transpiler');
var htmlRewriter = require('./html-rewriter');
var adblock = require('./adblock');

var USER_AGENTS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  tv: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 WebAppManager'
};

var currentUAMode = 'desktop';
var cookieJar = Object.create(null); // host -> { name: value }

// Embute os scripts de cliente em memória na inicialização
var POLYFILLS_CODE = fs.readFileSync(
  path.join(__dirname, 'client-injected', 'polyfills-chrome68.js'),
  'utf8'
);
var PROXY_HOOK_CODE = fs.readFileSync(
  path.join(__dirname, 'client-injected', 'proxy-hook.js'),
  'utf8'
);

function storeCookies(host, setCookieHeader) {
  if (!host || !setCookieHeader) return;
  var list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  if (!cookieJar[host]) cookieJar[host] = Object.create(null);
  for (var i = 0; i < list.length; i++) {
    var firstPart = String(list[i]).split(';')[0];
    var eqIdx = firstPart.indexOf('=');
    if (eqIdx > 0) {
      var k = firstPart.slice(0, eqIdx).trim();
      var v = firstPart.slice(eqIdx + 1).trim();
      cookieJar[host][k] = v;
    }
  }
}

function getCookieHeader(host) {
  if (!host || !cookieJar[host]) return '';
  var pairs = [];
  var jar = cookieJar[host];
  var keys = Object.keys(jar);
  for (var i = 0; i < keys.length; i++) {
    pairs.push(keys[i] + '=' + jar[keys[i]]);
  }
  return pairs.join('; ');
}

function getProxiedTargetUrl(rawUrl, proxyBase) {
  if (!rawUrl) return null;
  var parsedProxyUrl = urlModule.parse(rawUrl, true);
  var parsedProxyBase = urlModule.parse(proxyBase);
  if (
    parsedProxyUrl.protocol !== parsedProxyBase.protocol ||
    parsedProxyUrl.host !== parsedProxyBase.host ||
    parsedProxyUrl.pathname !== '/proxy' ||
    !parsedProxyUrl.query ||
    !parsedProxyUrl.query.url
  ) {
    return null;
  }

  try {
    var targetUrl = new URL(parsedProxyUrl.query.url);
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') return null;
    return targetUrl.href;
  } catch (_) {
    return null;
  }
}

function getUrlOrigin(targetUrl) {
  try {
    return new URL(targetUrl).origin;
  } catch (_) {
    return null;
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
}

function fetchUpstream(targetUrl, req, redirectsLeft, proxyBase, callback) {
  var parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return callback(new Error('URL inválida: ' + targetUrl));
  }

  var isHttps = parsed.protocol === 'https:';
  var transport = isHttps ? https : http;

  var headers = {
    'User-Agent': USER_AGENTS[currentUAMode] || USER_AGENTS.desktop,
    'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': req.headers['accept-language'] || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    // Node 8.12 no webOS 5.6.2 suporta gzip/deflate (Brotli só entrou no Node 11.7)
    'Accept-Encoding': 'gzip, deflate'
  };

  var upstreamReferer = getProxiedTargetUrl(req.headers['referer'], proxyBase);
  if (upstreamReferer) {
    headers['Referer'] = upstreamReferer;
  } else if (req.headers['referer']) {
    headers['Referer'] = req.headers['referer'];
  }

  if (req.headers['origin']) {
    var origin = req.headers['origin'];
    var proxyOrigin = getUrlOrigin(proxyBase);
    if (proxyOrigin && origin === proxyOrigin) {
      origin = getUrlOrigin(upstreamReferer || targetUrl) || origin;
    }
    headers['Origin'] = origin;
  }

  var savedCookies = getCookieHeader(parsed.hostname);
  if (savedCookies) {
    headers['Cookie'] = savedCookies;
  }

  // Encaminha cabeçalhos essenciais de requisição (POST, APIs, YouTube InnerTube x-*)
  var reqKeys = Object.keys(req.headers);
  for (var k = 0; k < reqKeys.length; k++) {
    var headerKey = reqKeys[k].toLowerCase();
    if (
      headerKey.indexOf('x-') === 0 ||
      headerKey === 'content-type' ||
      headerKey === 'content-length' ||
      headerKey === 'authorization' ||
      headerKey === 'range'
    ) {
      headers[headerKey] = req.headers[reqKeys[k]];
    }
  }

  var options = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method || 'GET',
    headers: headers,
    timeout: 20000,
    // ponytail: rejectUnauthorized=false contorna certificados raiz expirados no firmware webOS 5.6.2 (DST Root CA X3)
    rejectUnauthorized: false
  };

  // Essencial para Node 8.12 no webOS: define SNI (Server Name Indication) para sites HTTPS modernos
  if (isHttps) {
    options.servername = parsed.hostname;
    options.ciphers = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';
  }

  var upReq = transport.request(options, function (upRes) {
    storeCookies(parsed.hostname, upRes.headers['set-cookie']);

    var status = upRes.statusCode || 200;
    if ([301, 302, 303, 307, 308].indexOf(status) !== -1 && upRes.headers.location && redirectsLeft > 0) {
      upRes.resume();
      var nextUrl;
      try {
        nextUrl = new URL(upRes.headers.location, targetUrl).href;
      } catch (_) {
        nextUrl = upRes.headers.location;
      }
      return fetchUpstream(nextUrl, { method: 'GET', headers: req.headers }, redirectsLeft - 1, proxyBase, callback);
    }

    callback(null, upRes, targetUrl);
  });

  upReq.on('timeout', function () {
    upReq.abort();
    callback(new Error('Tempo limite excedido ao conectar a ' + parsed.hostname));
  });

  upReq.on('error', function (err) {
    callback(err);
  });

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    req.pipe(upReq);
  } else {
    upReq.end();
  }
}

function decodeStream(upRes) {
  var encoding = String(upRes.headers['content-encoding'] || '').toLowerCase();
  if (encoding.indexOf('gzip') !== -1) {
    return upRes.pipe(zlib.createGunzip());
  }
  if (encoding.indexOf('deflate') !== -1) {
    return upRes.pipe(zlib.createInflate());
  }
  return upRes;
}

function createProxyServer(port, host) {
  var listenPort = port || 8899;
  var listenHost = host || '127.0.0.1';
  var proxyBase = 'http://' + listenHost + ':' + listenPort;

  var server = http.createServer(function (req, res) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    var parsedReq = urlModule.parse(req.url, true);
    var pathname = parsedReq.pathname || '/';

    // 1. Health & Status Endpoint
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        engine: 'webos5-chrome68-transpiler',
        proxyBase: proxyBase,
        userAgentMode: currentUAMode,
        adblock: adblock.getStats()
      }));
    }

    // 2. Config Endpoint (AdBlock toggle, User-Agent mode, Limpar Cache/Cookies)
    if (pathname === '/config' && req.method === 'POST') {
      var bodyChunks = [];
      req.on('data', function (c) { bodyChunks.push(c); });
      req.on('end', function () {
        try {
          var payload = JSON.parse(Buffer.concat(bodyChunks).toString('utf8') || '{}');
          if (typeof payload.adblock === 'boolean') {
            adblock.setEnabled(payload.adblock);
          }
          if (payload.userAgentMode && USER_AGENTS[payload.userAgentMode]) {
            currentUAMode = payload.userAgentMode;
          }
          if (payload.clearSession) {
            cookieJar = Object.create(null);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            userAgentMode: currentUAMode,
            adblock: adblock.getStats()
          }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // 3. Scripts injetados de runtime para o Chromium 68
    if (pathname === '/client/polyfills-chrome68.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(POLYFILLS_CODE);
    }

    if (pathname === '/client/proxy-hook.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(PROXY_HOOK_CODE);
    }

    // 4. Endpoint principal do Proxy: /proxy?url=...
    if (pathname === '/proxy') {
      var targetUrl = parsedReq.query && parsedReq.query.url;
      var typeHint = (parsedReq.query && parsedReq.query.type) || '';

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Parâmetro ?url= obrigatório');
      }

      if (adblock.shouldBlock(targetUrl)) {
        if (typeHint === 'js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          return res.end('/* blocked by webOS AdBlock */');
        }
        res.writeHead(204);
        return res.end();
      }

      fetchUpstream(targetUrl, req, 5, proxyBase, function (err, upRes, finalUrl) {
        if (err) {
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(
            '<!DOCTYPE html><html><body style="background:#12151e;color:#e2e8f0;font-family:sans-serif;padding:40px;">' +
            '<h2>Não foi possível carregar a página</h2>' +
            '<p style="color:#94a3b8">' + String(err.message) + '</p>' +
            '<p>URL: <code>' + String(targetUrl) + '</code></p>' +
            '</body></html>'
          );
        }

        var contentType = String(upRes.headers['content-type'] || '').toLowerCase();
        var isHTML = typeHint === 'doc' || contentType.indexOf('text/html') !== -1 || contentType.indexOf('application/xhtml+xml') !== -1;
        var isJS =
          typeHint === 'js' ||
          contentType.indexOf('javascript') !== -1 ||
          contentType.indexOf('ecmascript') !== -1 ||
          /\.m?js(\?|$)/i.test(finalUrl);
        var isCSS = typeHint === 'css' || contentType.indexOf('text/css') !== -1 || /\.css(\?|$)/i.test(finalUrl);

        // Copia cabeçalhos seguros removendo bloqueios de iframe e CSP
        var blockedHeaders = {
          'x-frame-options': true,
          'content-security-policy': true,
          'content-security-policy-report-only': true,
          'cross-origin-embedder-policy': true,
          'cross-origin-opener-policy': true,
          'cross-origin-resource-policy': true,
          'strict-transport-security': true,
          'content-encoding': true,
          'content-length': true,
          'transfer-encoding': true,
          'set-cookie': true
        };

        var headerKeys = Object.keys(upRes.headers);
        for (var i = 0; i < headerKeys.length; i++) {
          var k = headerKeys[i].toLowerCase();
          if (!blockedHeaders[k] && upRes.headers[headerKeys[i]] !== undefined) {
            try {
              res.setHeader(headerKeys[i], upRes.headers[headerKeys[i]]);
            } catch (_) {}
          }
        }
        setCorsHeaders(res);

        // Se for mídia binária, imagem, fonte ou vídeo, faz stream direto sem carregar em RAM
        if (!isHTML && !isJS && !isCSS) {
          res.writeHead(upRes.statusCode || 200);
          var rawStream = decodeStream(upRes);
          rawStream.on('error', function () { res.end(); });
          return rawStream.pipe(res);
        }

        // Acumula texto para transpilar HTML / JS / CSS
        var decoded = decodeStream(upRes);
        var chunks = [];
        var totalBytes = 0;
        var MAX_TEXT_BYTES = 32 * 1024 * 1024; // 32 MB (suporta bundles grandes como YouTube sem truncar)

        decoded.on('data', function (chunk) {
          totalBytes += chunk.length;
          chunks.push(chunk);
        });

        decoded.on('error', function () {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Erro ao descomprimir resposta');
        });

        decoded.on('end', function () {
          var rawText = Buffer.concat(chunks).toString('utf8');
          var outputText = rawText;

          if (isHTML && (typeHint !== 'xhr' || contentType.indexOf('text/html') !== -1)) {
            outputText = htmlRewriter.rewriteHTML(rawText, finalUrl, proxyBase);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
          } else if (isJS) {
            outputText = transpiler.transpileJS(rawText, finalUrl);
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          } else if (isCSS) {
            outputText = transpiler.transpileCSS(rawText, finalUrl, proxyBase);
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
          }

          var outBuf = Buffer.from(outputText, 'utf8');
          res.setHeader('Content-Length', String(outBuf.length));
          res.writeHead(upRes.statusCode || 200);
          res.end(outBuf);
        });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  return {
    server: server,
    start: function (cb) {
      server.listen(listenPort, listenHost, function () {
        if (cb) cb(null, { port: listenPort, host: listenHost, proxyBase: proxyBase });
      });
      server.on('error', function (err) {
        if (cb) cb(err);
      });
    }
  };
}

module.exports = {
  createProxyServer: createProxyServer
};
