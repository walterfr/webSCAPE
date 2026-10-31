/**
 * HTML Rewriter para LG webOS 5.6.2 (Chromium 68)
 * - Remove meta CSP e atributos integrity/nonce que bloqueariam scripts transpilados
 * - Injeta polyfills do Chrome 68 e proxy-hook no topo do <head>
 * - Reescreve <script src>, <link href>, <img src>, <iframe src> e transpila <script>/<style> inline
 */
'use strict';

var urlModule = require('url');
var URL = global.URL || urlModule.URL;
var transpiler = require('./transpiler');
var adblock = require('./adblock');
var originMap = require('./origin-map');

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function resolveUrl(rawUrl, baseUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  var u = decodeHtmlEntities(rawUrl).trim();
  if (
    !u ||
    u.indexOf('data:') === 0 ||
    u.indexOf('blob:') === 0 ||
    u.indexOf('javascript:') === 0 ||
    u.indexOf('mailto:') === 0 ||
    u.indexOf('about:') === 0 ||
    u.charAt(0) === '#'
  ) {
    return null;
  }
  try {
    return new URL(u, baseUrl).href;
  } catch (_) {
    return null;
  }
}

function makeProxyUrl(targetUrl, proxyBase, type) {
  var suffix = type ? '&type=' + encodeURIComponent(type) : '';
  return originMap.getProxyBaseForUrl(targetUrl, proxyBase) + '/proxy?url=' + encodeURIComponent(targetUrl) + suffix;
}

function rewriteHTML(html, targetUrl, proxyBase) {
  if (!html || typeof html !== 'string') return html;

  var out = html;

  // 1. Remove meta tags de Content-Security-Policy e X-Frame-Options
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*['"]?(?:content-security-policy|x-frame-options)['"]?[^>]*>/gi, '');

  // 2. Remove atributos integrity="..." e crossorigin="..." que invalidam scripts transpilados
  out = out.replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s+nonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 3. Reescreve <script ... src="..."> e transpila <script> inline
  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, function (full, attrs, body) {
    var srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (srcMatch) {
      var rawSrc = srcMatch[1] || srcMatch[2] || srcMatch[3] || '';
      var resolved = resolveUrl(rawSrc, targetUrl);
      if (resolved) {
        if (adblock.shouldBlock(resolved)) {
          return '<!-- blocked ad script: ' + resolved + ' -->';
        }
        var proxiedSrc = makeProxyUrl(resolved, proxyBase, 'js');
        var newAttrs = attrs
          .replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, 'src="' + proxiedSrc + '"')
          .replace(/\btype\s*=\s*['"]?module['"]?/i, ''); // evita CORS estrito de module em scripts simples
        return '<script' + newAttrs + '></script>';
      }
      return full;
    }

    // Script inline: verifica se é JS executável (ignora application/ld+json, importmap, template)
    var typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    var scriptType = typeMatch ? (typeMatch[1] || typeMatch[2] || typeMatch[3] || '').toLowerCase() : '';
    var isExecutableJS =
      !scriptType ||
      scriptType === 'text/javascript' ||
      scriptType === 'application/javascript' ||
      scriptType === 'module';

    if (isExecutableJS && body && body.trim()) {
      var transpiled = transpiler.transpileJS(body, targetUrl);
      return '<script' + attrs + '>' + transpiled + '</script>';
    }

    return full;
  });

  // 4. Reescreve <link ... href="..."> (CSS e ícones)
  out = out.replace(/<link\b([^>]*)>/gi, function (full, attrs) {
    var hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!hrefMatch) return full;
    var rawHref = hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '';
    var resolved = resolveUrl(rawHref, targetUrl);
    if (!resolved) return full;

    var isStylesheet = /\brel\s*=\s*['"]?stylesheet['"]?/i.test(attrs) || /\.css(\?|$)/i.test(resolved);
    var proxiedHref = makeProxyUrl(resolved, proxyBase, isStylesheet ? 'css' : 'raw');
    var newAttrs = attrs.replace(/\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, 'href="' + proxiedHref + '"');
    return '<link' + newAttrs + '>';
  });

  // 5. Transforma <style>...</style> inline (converte inset, clamp, url, :where)
  out = out.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, function (full, attrs, cssBody) {
    if (!cssBody || !cssBody.trim()) return full;
    var fixedCss = transpiler.transpileCSS(cssBody, targetUrl, proxyBase);
    return '<style' + attrs + '>' + fixedCss + '</style>';
  });

  // 6. Reescreve <img src>, <source src>, <video src>, <iframe src>, <form action>
  out = out.replace(/<(img|source|video|audio|iframe|form)\b([^>]*)>/gi, function (full, tag, attrs) {
    var t = tag.toLowerCase();
    var attrName = t === 'form' ? 'action' : 'src';
    var rx = new RegExp('\\b' + attrName + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
    var m = attrs.match(rx);
    if (!m) return full;
    var rawUrl = m[1] || m[2] || m[3] || '';
    var resolved = resolveUrl(rawUrl, targetUrl);
    if (!resolved) return full;
    if (adblock.shouldBlock(resolved)) {
      return t === 'iframe' ? '<!-- blocked ad iframe -->' : full;
    }
    var typeHint = (t === 'iframe' || t === 'form') ? 'doc' : 'raw';
    var proxied = makeProxyUrl(resolved, proxyBase, typeHint);
    var updatedAttrs = attrs.replace(rx, attrName + '="' + proxied + '"');
    return '<' + tag + updatedAttrs + '>';
  });

  // 7. Injeta polyfills do Chrome 68 e proxy-hook no topo do <head>
  var injection =
    '\n<!-- webSCAPE Runtime -->\n' +
    '<script>' +
    'window.__WEBOS_PROXY_BASE__=' + JSON.stringify(proxyBase) + ';' +
    'window.__WEBOS_PROXY_TARGET__=' + JSON.stringify(targetUrl) + ';' +
    '</script>\n' +
    '<script src="' + proxyBase + '/client/polyfills-chrome68.js"></script>\n' +
    '<script src="' + proxyBase + '/client/proxy-hook.js"></script>\n';

  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, function (match) {
      return match + injection;
    });
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, function (match) {
      return match + '<head>' + injection + '</head>';
    });
  } else {
    out = injection + out;
  }

  return out;
}

module.exports = {
  rewriteHTML: rewriteHTML
};
