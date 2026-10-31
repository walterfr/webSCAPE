/**
 * Servidor Proxy Reverso Transpilador para LG webOS 5.6.2
 * Compatível com Node.js 8.12.0 (usa módulos nativos do Node).
 * - Usa Accept-Encoding: gzip, deflate (Node 8.12 não possui Brotli nativo)
 * - Valida certificados TLS para proteger conexões HTTPS
 * - Remove X-Frame-Options e CSP
 * - Transpila HTML, JS (ES2024 -> Chrome 68) e CSS em tempo real
 */
'use strict';

var http = require('http');
var https = require('https');
var dns = require('dns');
var net = require('net');
var crypto = require('crypto');
var urlModule = require('url');
var URL = global.URL || urlModule.URL;
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');

var transpiler = require('./transpiler');
var htmlRewriter = require('./html-rewriter');
var adblock = require('./adblock');
var originMap = require('./origin-map');

var USER_AGENTS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  tv: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 WebAppManager'
};

var currentUAMode = 'desktop';
var cookieJar = Object.create(null); // host -> { name: value }

function isPublicAddress(address, family) {
  if (family === 4) {
    var octets = address.split('.').map(Number);
    var a = octets[0];
    var b = octets[1];
    var c = octets[2];
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && c === 0) || b === 168 || (b === 88 && c === 99))) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }

  if (family !== 6) return false;
  var parts = address.toLowerCase().split(':');
  var emptyIndex = parts.indexOf('');
  if (emptyIndex !== -1) {
    var missing = 8 - parts.filter(Boolean).length;
    parts.splice.apply(parts, [emptyIndex, parts.lastIndexOf('') - emptyIndex + 1].concat(new Array(missing).fill('0')));
  }
  while (parts.length < 8) parts.push('0');
  var first = parseInt(parts[0] || '0', 16);
  var second = parseInt(parts[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff &&
    !(first === 0x2001 && second <= 0x01ff) &&
    !(first === 0x2001 && second === 0x0db8) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second < 0x1000);
}

function resolvePublicAddress(host, callback) {
  var hostname = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal|test|invalid|example)$/.test(hostname) || hostname.indexOf('.') === -1) {
    return callback(new Error('Destino local ou reservado bloqueado'));
  }

  var literalFamily = net.isIP(hostname);
  var resolved = function (err, addresses) {
    if (err || !addresses || !addresses.length) {
      return callback(err || new Error('Não foi possível resolver o destino'));
    }
    for (var i = 0; i < addresses.length; i++) {
      if (!isPublicAddress(addresses[i].address, addresses[i].family)) {
        return callback(new Error('Destino local ou reservado bloqueado'));
      }
    }
    var preferred = addresses.filter(function (item) { return item.family === 4; })[0] || addresses[0];
    callback(null, preferred.address, preferred.family);
  };

  if (literalFamily) return resolved(null, [{ address: hostname, family: literalFamily }]);
  dns.lookup(hostname, { all: true }, resolved);
}

function hasValidControlToken(received, expected) {
  if (typeof received !== 'string' || !expected || Buffer.byteLength(received) !== Buffer.byteLength(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

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
  var parsedOrigin = parsedProxyUrl.protocol + '//' + parsedProxyUrl.host;
  var isProxyOrigin = parsedProxyUrl.protocol === parsedProxyBase.protocol && parsedProxyUrl.host === parsedProxyBase.host;
  if (!isProxyOrigin) isProxyOrigin = !!originMap.getOriginalOrigin(parsedOrigin);
  if (
    !isProxyOrigin ||
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

function setCorsHeaders(res, origin, proxyBase, upstreamResponse, targetUrl) {
  var proxyOrigin = getUrlOrigin(proxyBase);
  var allowed = origin === 'null' || origin === proxyOrigin;
  var sourceOrigin = originMap.getOriginalOrigin(origin);
  if (sourceOrigin && targetUrl && upstreamResponse) {
    var sourceHeader = upstreamResponse.headers['access-control-allow-origin'];
    allowed = sourceHeader === '*' || sourceHeader === sourceOrigin || sourceOrigin === getUrlOrigin(targetUrl);
  }
  if (!allowed) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (origin === 'null' || origin === proxyOrigin) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-WebOS-Control-Token');
  }
}

function fetchUpstream(targetUrl, req, redirectsLeft, proxyBase, callback) {
  var parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return callback(new Error('URL inválida: ' + targetUrl));
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return callback(new Error('Protocolo bloqueado'));
  }

  resolvePublicAddress(parsed.hostname, function (addressError, resolvedAddress, resolvedFamily) {
    if (addressError) return callback(addressError);

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
    var mappedOrigin = originMap.getOriginalOrigin(origin);
    if (mappedOrigin) {
      origin = mappedOrigin;
    } else if (proxyOrigin && origin === proxyOrigin) {
      origin = getUrlOrigin(upstreamReferer || targetUrl) || origin;
    }
    headers['Origin'] = origin;
  }

  var sourceOrigin = originMap.getOriginalOrigin(req.headers.origin);
  var refererOrigin = null;
  try {
    if (upstreamReferer) refererOrigin = getUrlOrigin(upstreamReferer);
  } catch (_) {}
  var isTopLevelDocument = req._webosTypeHint === 'doc' &&
    /text\/html/i.test(req.headers.accept || '') && !sourceOrigin;
  var mayUseCookies = refererOrigin === getUrlOrigin(targetUrl) || isTopLevelDocument ||
    (!req.headers.origin && !upstreamReferer && req._webosTypeHint === 'doc');
  var savedCookies = mayUseCookies ? getCookieHeader(parsed.hostname) : '';
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
      headerKey === 'range' ||
      headerKey === 'access-control-request-method' ||
      headerKey === 'access-control-request-headers'
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
    lookup: function (hostname, options, done) {
      if (typeof options === 'function') done = options;
      done(null, resolvedAddress, resolvedFamily);
    },
    timeout: 20000,
    rejectUnauthorized: true
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
      var redirectedReq = { method: 'GET', headers: req.headers, _webosTypeHint: req._webosTypeHint };
      return fetchUpstream(nextUrl, redirectedReq, redirectsLeft - 1, proxyBase, callback);
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
  });
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
  var controlToken = crypto.randomBytes(32).toString('hex');

  var server = http.createServer(function (req, res) {
    setCorsHeaders(res, req.headers.origin, proxyBase);

    var parsedReq = urlModule.parse(req.url, true);
    var pathname = parsedReq.pathname || '/';

    if (req.method === 'OPTIONS' && pathname !== '/proxy') {
      res.writeHead(204);
      return res.end();
    }

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
      if (!hasValidControlToken(req.headers['x-webos-control-token'], controlToken)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'Acesso não autorizado' }));
      }
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
      var requestProxyBase = 'http://' + (req.headers.host || (listenHost + ':' + listenPort));
      var routeQuery = parsedReq.query || {};
      var urlValues = Array.isArray(routeQuery.url) ? routeQuery.url.slice() : [routeQuery.url];
      var targetUrl = urlValues.shift();
      var typeValues = Array.isArray(routeQuery.type) ? routeQuery.type.slice() : [routeQuery.type];
      var routeTypes = ['doc', 'js', 'css', 'raw', 'xhr'];
      var typeHint = routeTypes.indexOf(typeValues[0]) !== -1 ? typeValues.shift() : '';
      var forwardedParams = [];

      Object.keys(routeQuery).forEach(function (key) {
        var values = key === 'url' ? urlValues : key === 'type' ? typeValues :
          (Array.isArray(routeQuery[key]) ? routeQuery[key] : [routeQuery[key]]);
        for (var i = 0; i < values.length; i++) {
          forwardedParams.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(values[i])));
        }
      });

      if (typeof targetUrl !== 'string' || !targetUrl) {
        targetUrl = originMap.getLastDocumentTarget(requestProxyBase);
        if (targetUrl && !typeHint) typeHint = 'doc';
      }

      if (forwardedParams.length && typeof targetUrl === 'string') {
        var hashIndex = targetUrl.indexOf('#');
        var fragment = hashIndex === -1 ? '' : targetUrl.slice(hashIndex);
        var targetWithoutFragment = hashIndex === -1 ? targetUrl : targetUrl.slice(0, hashIndex);
        var querySeparator = targetWithoutFragment.indexOf('?') === -1 ? '?' : /[?&]$/.test(targetWithoutFragment) ? '' : '&';
        targetUrl = targetWithoutFragment + querySeparator + forwardedParams.join('&') + fragment;
      }

      if (typeof targetUrl !== 'string' || !targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Parâmetro ?url= obrigatório');
      }

      var target;
      try {
        target = new URL(targetUrl);
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('URL inválida');
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Protocolo bloqueado');
      }

      var targetProxyBase = originMap.getProxyBaseForUrl(target.href, proxyBase);
      if (requestProxyBase === proxyBase && typeHint === 'doc' && req.method !== 'OPTIONS') {
        res.writeHead(302, { Location: targetProxyBase + '/proxy?url=' + encodeURIComponent(target.href) + '&type=doc' });
        return res.end();
      }
      if (requestProxyBase !== targetProxyBase) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Origem do proxy não corresponde ao destino');
      }

      if (req.method === 'OPTIONS') {
        req._webosTypeHint = typeHint;
        fetchUpstream(target.href, req, 5, requestProxyBase, function (err, upRes) {
          if (err) {
            res.writeHead(502);
            return res.end();
          }
          ['access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials', 'access-control-max-age'].forEach(function (header) {
            if (upRes.headers[header]) res.setHeader(header, upRes.headers[header]);
          });
          setCorsHeaders(res, req.headers.origin, proxyBase, upRes, target.href);
          res.writeHead(upRes.statusCode || 204);
          return res.end();
        });
        return;
      }

      if (adblock.shouldBlock(targetUrl)) {
        if (typeHint === 'js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          return res.end('/* blocked by webOS AdBlock */');
        }
        res.writeHead(204);
        return res.end();
      }

      req._webosTypeHint = typeHint;
      fetchUpstream(targetUrl, req, 5, requestProxyBase, function (err, upRes, finalUrl) {
        if (err) {
          res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(
            '<!DOCTYPE html><html><body style="background:#12151e;color:#e2e8f0;font-family:sans-serif;padding:40px;">' +
            '<h2>Não foi possível carregar a página</h2>' +
            '<p style="color:#94a3b8">' + escapeHtml(err.message) + '</p>' +
            '<p>URL: <code>' + escapeHtml(targetUrl) + '</code></p>' +
            '</body></html>'
          );
        }

        var finalProxyBase = originMap.getProxyBaseForUrl(finalUrl, proxyBase);
        if (typeHint === 'doc' && finalProxyBase !== requestProxyBase) {
          res.writeHead(302, { Location: finalProxyBase + '/proxy?url=' + encodeURIComponent(finalUrl) + '&type=doc' });
          return res.end();
        }

        var contentType = String(upRes.headers['content-type'] || '').toLowerCase();
        var isHTML = typeHint === 'doc' || contentType.indexOf('text/html') !== -1 || contentType.indexOf('application/xhtml+xml') !== -1;
        if (typeHint === 'doc' && isHTML) originMap.setLastDocumentTarget(requestProxyBase, finalUrl);
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
          'set-cookie': true,
          'access-control-allow-origin': true
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
        setCorsHeaders(res, req.headers.origin, proxyBase, upRes, finalUrl);

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
            outputText = htmlRewriter.rewriteHTML(rawText, finalUrl, requestProxyBase);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
          } else if (isJS) {
            outputText = transpiler.transpileJS(rawText, finalUrl);
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          } else if (isCSS) {
            outputText = transpiler.transpileCSS(rawText, finalUrl, requestProxyBase);
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
    controlToken: controlToken,
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
