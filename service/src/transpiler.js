/**
 * Transpilador JS (ES2019–ES2025 -> Chromium 68 / V8 6.8) e Transformador CSS
 * Projetado para rodar em Node.js 8.12+ (webOS 5.6.2 JS Service) sem binários C++.
 */
'use strict';

var urlModule = require('url');
var URL = global.URL || urlModule.URL;
var sucrase = require('sucrase');
var crypto = require('crypto');

// Cache LRU simples em memória (evita re-transpilar scripts repetidos e economiza RAM da TV)
var MAX_CACHE_ENTRIES = 80;
var jsCache = new Map();

function getCacheKey(code) {
  return crypto.createHash('md5').update(code).digest('hex');
}

function cacheGet(key) {
  if (!jsCache.has(key)) return null;
  var val = jsCache.get(key);
  jsCache.delete(key);
  jsCache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  if (jsCache.size >= MAX_CACHE_ENTRIES) {
    var oldestKey = jsCache.keys().next().value;
    jsCache.delete(oldestKey);
  }
  jsCache.set(key, val);
}

/**
 * Pré-processador léxico rápido (ignora strings, template literals e comentários)
 * Converte sintaxes ES2021-ES2024 que o Sucrase base mantém intactas:
 * - Campos/métodos privados (#prop -> __priv_prop) e (#prop in obj -> "__priv_prop" in obj)
 * - Logical assignment (a ??= b, a ||= b, a &&= b)
 */
function preprocessModernSyntax(code) {
  // 1. Substitui identificadores privados fora de strings/comentários
  var out = '';
  var i = 0;
  var len = code.length;

  while (i < len) {
    var ch = code[i];
    var next = code[i + 1];

    // Comentário de linha //
    if (ch === '/' && next === '/') {
      var endLine = code.indexOf('\n', i + 2);
      if (endLine === -1) endLine = len;
      out += code.slice(i, endLine);
      i = endLine;
      continue;
    }

    // Comentário de bloco /* */
    if (ch === '/' && next === '*') {
      var endBlock = code.indexOf('*/', i + 2);
      if (endBlock === -1) endBlock = len;
      else endBlock += 2;
      out += code.slice(i, endBlock);
      i = endBlock;
      continue;
    }

    // Strings ' ou " ou `
    if (ch === "'" || ch === '"' || ch === '`') {
      var quote = ch;
      out += ch;
      i++;
      while (i < len) {
        var c = code[i];
        out += c;
        i++;
        if (c === '\\' && i < len) {
          out += code[i];
          i++;
        } else if (c === quote) {
          break;
        }
      }
      continue;
    }

    // Identificador privado #nome (exceto shebang #! no início)
    if (ch === '#' && next !== '!' && /[a-zA-Z_$]/.test(next || '')) {
      var m = code.slice(i + 1).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
      if (m) {
        var ident = m[0];
        var afterPos = i + 1 + ident.length;
        var restTrimmed = code.slice(afterPos).match(/^\s+in\b/);
        // Só trata como ergonomia de private check (#x in obj) quando precedido por início de expressão
        var prevNonSpace = out.trimEnd().slice(-1);
        var isBrandCheck = restTrimmed && (!prevNonSpace || '({[=;:?,!&|'.indexOf(prevNonSpace) !== -1);
        if (isBrandCheck) {
          out += '"__priv_' + ident + '"';
        } else {
          out += '__priv_' + ident;
        }
        i = afterPos;
        continue;
      }
    }

    out += ch;
    i++;
  }

  // 2. Transforma operadores de atribuição lógica (??=, ||=, &&=)
  out = out.replace(
    /([a-zA-Z_$][a-zA-Z0-9_$.[\]]*)\s*(\?\?=|\|\|=|&&=)\s*([^;,\n)]+)/g,
    function (_, lhs, op, rhs) {
      var baseOp = op.slice(0, 2);
      return lhs + ' = ' + lhs + ' ' + baseOp + ' (' + rhs + ')';
    }
  );

  return out;
}

/**
 * Verifica rapidamente se o código JS contém sintaxe incompatível com Chromium 68
 */
function needsJSTranspile(code) {
  if (!code || code.length < 3) return false;
  return (
    code.indexOf('?.') !== -1 ||
    code.indexOf('??') !== -1 ||
    code.indexOf('||=') !== -1 ||
    code.indexOf('&&=') !== -1 ||
    code.indexOf('#') !== -1 ||
    /\bclass\s+[^{]*\{/.test(code) ||
    /\d_\d/.test(code)
  );
}

/**
 * Transpila JavaScript moderno para Chromium 68 (ES2018)
 */
function transpileJS(code, sourceUrl) {
  if (!code || typeof code !== 'string') return code;
  if (!needsJSTranspile(code)) return code;

  var key = getCacheKey(code);
  var cached = cacheGet(key);
  if (cached !== null) return cached;

  try {
    var preprocessed = preprocessModernSyntax(code);
    var result = sucrase.transform(preprocessed, {
      transforms: [],
      production: true,
      disableESTransforms: false
    });
    cacheSet(key, result.code);
    return result.code;
  } catch (err) {
    // Se for script de módulo ou sintaxe que falhou no parser, retorna o pré-processado sem quebrar a página
    try {
      var fallback = preprocessModernSyntax(code);
      return fallback;
    } catch (_) {
      return code;
    }
  }
}

/**
 * Transforma propriedades CSS modernas ausentes no Chromium 68:
 * - inset: a [b c d] -> top/right/bottom/left
 * - inset-inline / inset-block -> left/right e top/bottom
 * - clamp(min, val, max) -> val (evita que o Chrome 68 descarte a regra inteira)
 * - Reescreve url(...) relativos para passar pelo proxy
 */
function transpileCSS(css, baseUrl, proxyBase) {
  if (!css || typeof css !== 'string') return css;

  var out = css;

  // 1. Converte inset: <valores> (Chrome 87 -> Chrome 68)
  out = out.replace(
    /(^|[{;\s])inset\s*:\s*([^;!}]+)(\s*!important)?\s*(?=[;}])/gi,
    function (_, prefix, rawVals, important) {
      var imp = important || '';
      var parts = rawVals.trim().split(/\s+/);
      var t, r, b, l;
      if (parts.length === 1) {
        t = r = b = l = parts[0];
      } else if (parts.length === 2) {
        t = b = parts[0];
        r = l = parts[1];
      } else if (parts.length === 3) {
        t = parts[0];
        r = l = parts[1];
        b = parts[2];
      } else {
        t = parts[0];
        r = parts[1];
        b = parts[2];
        l = parts[3];
      }
      return (
        prefix +
        'top:' + t + imp + ';' +
        'right:' + r + imp + ';' +
        'bottom:' + b + imp + ';' +
        'left:' + l + imp
      );
    }
  );

  // 2. Converte inset-inline e inset-block
  out = out.replace(
    /(^|[{;\s])inset-inline\s*:\s*([^;!}]+)(\s*!important)?\s*(?=[;}])/gi,
    function (_, prefix, val, imp) {
      var p = val.trim().split(/\s+/);
      var l = p[0];
      var r = p[1] || p[0];
      var i = imp || '';
      return prefix + 'left:' + l + i + ';right:' + r + i;
    }
  );
  out = out.replace(
    /(^|[{;\s])inset-block\s*:\s*([^;!}]+)(\s*!important)?\s*(?=[;}])/gi,
    function (_, prefix, val, imp) {
      var p = val.trim().split(/\s+/);
      var t = p[0];
      var b = p[1] || p[0];
      var i = imp || '';
      return prefix + 'top:' + t + i + ';bottom:' + b + i;
    }
  );

  // 3. Fallback de clamp(min, preferred, max) -> preferred (Chrome 79 -> Chrome 68)
  out = out.replace(/clamp\(\s*([^,()]+)\s*,\s*([^,()]+)\s*,\s*([^,()]+)\s*\)/gi, function (_, minV, prefV) {
    return prefV.trim();
  });

  // 4. Converte :where(...) simples para seletor direto compatível com Chrome 68
  out = out.replace(/:where\(\s*([^(),]+)\s*\)/g, '$1');
  out = out.replace(/:is\(\s*([^(),]+)\s*\)/g, '$1');

  // 5. Reescreve url(...) relativos para o proxy se baseUrl e proxyBase forem fornecidos
  if (baseUrl && proxyBase) {
    out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (full, quote, rawUrl) {
      var u = rawUrl.trim();
      if (!u || u.indexOf('data:') === 0 || u.indexOf('blob:') === 0 || u.indexOf('#') === 0 || u.indexOf(proxyBase) === 0) {
        return full;
      }
      try {
        var resolved = new URL(u, baseUrl).href;
        return 'url(' + quote + proxyBase + '/proxy?url=' + encodeURIComponent(resolved) + quote + ')';
      } catch (_) {
        return full;
      }
    });
  }

  return out;
}

module.exports = {
  transpileJS: transpileJS,
  transpileCSS: transpileCSS,
  needsJSTranspile: needsJSTranspile
};
