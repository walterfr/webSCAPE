'use strict';

var originByProxyHost = Object.create(null);
var lastDocumentByProxyHost = Object.create(null);

function hashOrigin(origin) {
  var first = 0x811c9dc5;
  var second = 0x9e3779b9;
  for (var i = 0; i < origin.length; i++) {
    var code = origin.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return ('00000000' + (first >>> 0).toString(16)).slice(-8) +
    ('00000000' + (second >>> 0).toString(16)).slice(-8);
}

function getProxyBaseForUrl(targetUrl, proxyBase) {
  var target = new URL(targetUrl);
  var base = new URL(proxyBase);
  var host = 'w' + hashOrigin(target.origin) + '.localhost' + (base.port ? ':' + base.port : '');
  originByProxyHost['http://' + host] = target.origin;
  return 'http://' + host;
}

function getOriginalOrigin(proxyOrigin) {
  return originByProxyHost[proxyOrigin] || null;
}

function setLastDocumentTarget(proxyBase, targetUrl) {
  if (originByProxyHost[proxyBase]) lastDocumentByProxyHost[proxyBase] = targetUrl;
}

function getLastDocumentTarget(proxyBase) {
  return lastDocumentByProxyHost[proxyBase] || null;
}

module.exports = {
  getProxyBaseForUrl: getProxyBaseForUrl,
  getOriginalOrigin: getOriginalOrigin,
  setLastDocumentTarget: setLastDocumentTarget,
  getLastDocumentTarget: getLastDocumentTarget
};
