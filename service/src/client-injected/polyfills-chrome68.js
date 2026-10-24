/**
 * Polyfills para Chromium 68 (LG webOS 5.6.2)
 * Supre APIs ECMAScript 2019-2025 e DOM modernas ausentes no motor WAM nativo.
 */
(function () {
  'use strict';

  // 1. globalThis (Chrome 71)
  if (typeof globalThis === 'undefined') {
    Object.defineProperty(Object.prototype, '__magic_global__', {
      get: function () { return this; },
      configurable: true
    });
    __magic_global__.globalThis = __magic_global__;
    delete Object.prototype.__magic_global__;
  }

  // 2. Object.fromEntries (Chrome 73)
  if (!Object.fromEntries) {
    Object.fromEntries = function ( entries ) {
      if (!entries || !entries[Symbol.iterator]) {
        throw new TypeError('Object.fromEntries requires an iterable');
      }
      var obj = {};
      for (var pair of entries) {
        if (Object(pair) !== pair) {
          throw new TypeError('iterable for fromEntries should yield objects');
        }
        obj[pair[0]] = pair[1];
      }
      return obj;
    };
  }

  // 3. Object.hasOwn (Chrome 93)
  if (!Object.hasOwn) {
    var hasOwnProp = Object.prototype.hasOwnProperty;
    Object.hasOwn = function (obj, prop) {
      if (obj == null) {
        throw new TypeError('Cannot convert undefined or null to object');
      }
      return hasOwnProp.call(Object(obj), prop);
    };
  }

  // 4. Object.groupBy & Map.groupBy (Chrome 117)
  if (!Object.groupBy) {
    Object.groupBy = function (items, callbackFn) {
      var obj = Object.create(null);
      var i = 0;
      for (var item of items) {
        var key = callbackFn(item, i++);
        if (!(key in obj)) obj[key] = [];
        obj[key].push(item);
      }
      return obj;
    };
  }
  if (typeof Map !== 'undefined' && !Map.groupBy) {
    Map.groupBy = function (items, callbackFn) {
      var map = new Map();
      var i = 0;
      for (var item of items) {
        var key = callbackFn(item, i++);
        var list = map.get(key);
        if (!list) {
          list = [];
          map.set(key, list);
        }
        list.push(item);
      }
      return map;
    };
  }

  // 5. Array.prototype.flat & flatMap (Chrome 69 - ausente no Chrome 68!)
  if (!Array.prototype.flat) {
    Object.defineProperty(Array.prototype, 'flat', {
      configurable: true,
      writable: true,
      value: function flat(depth) {
        var d = depth === undefined ? 1 : Number(depth);
        var result = [];
        var flatten = function (arr, currentDepth) {
          for (var i = 0; i < arr.length; i++) {
            if (!(i in arr)) continue;
            var el = arr[i];
            if (Array.isArray(el) && currentDepth > 0) {
              flatten(el, currentDepth - 1);
            } else {
              result.push(el);
            }
          }
        };
        flatten(this, d);
        return result;
      }
    });
  }

  if (!Array.prototype.flatMap) {
    Object.defineProperty(Array.prototype, 'flatMap', {
      configurable: true,
      writable: true,
      value: function flatMap(callback, thisArg) {
        return this.map(callback, thisArg).flat(1);
      }
    });
  }

  // 6. .at() em Array, String e TypedArray (Chrome 92)
  function atPolyfill(n) {
    n = Math.trunc(n) || 0;
    if (n < 0) n += this.length;
    if (n < 0 || n >= this.length) return undefined;
    return this[n];
  }
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, 'at', {
      value: atPolyfill, writable: true, configurable: true
    });
  }
  if (!String.prototype.at) {
    Object.defineProperty(String.prototype, 'at', {
      value: atPolyfill, writable: true, configurable: true
    });
  }
  if (typeof Int8Array !== 'undefined' && !Int8Array.prototype.at) {
    var TypedArrayProto = Object.getPrototypeOf(Int8Array.prototype);
    if (TypedArrayProto && !TypedArrayProto.at) {
      Object.defineProperty(TypedArrayProto, 'at', {
        value: atPolyfill, writable: true, configurable: true
      });
    }
  }

  // 7. Array.prototype.findLast & findLastIndex (Chrome 97)
  if (!Array.prototype.findLast) {
    Object.defineProperty(Array.prototype, 'findLast', {
      configurable: true, writable: true,
      value: function (predicate, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      }
    });
  }
  if (!Array.prototype.findLastIndex) {
    Object.defineProperty(Array.prototype, 'findLastIndex', {
      configurable: true, writable: true,
      value: function (predicate, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return i;
        }
        return -1;
      }
    });
  }

  // 8. Array Change-by-copy: toReversed, toSorted, toSpliced, with (Chrome 110)
  if (!Array.prototype.toReversed) {
    Object.defineProperty(Array.prototype, 'toReversed', {
      configurable: true, writable: true,
      value: function () { return Array.from(this).reverse(); }
    });
  }
  if (!Array.prototype.toSorted) {
    Object.defineProperty(Array.prototype, 'toSorted', {
      configurable: true, writable: true,
      value: function (compareFn) { return Array.from(this).sort(compareFn); }
    });
  }
  if (!Array.prototype.toSpliced) {
    Object.defineProperty(Array.prototype, 'toSpliced', {
      configurable: true, writable: true,
      value: function () {
        var copy = Array.from(this);
        Array.prototype.splice.apply(copy, arguments);
        return copy;
      }
    });
  }
  if (!Array.prototype.with) {
    Object.defineProperty(Array.prototype, 'with', {
      configurable: true, writable: true,
      value: function (index, value) {
        var copy = Array.from(this);
        var i = Math.trunc(index) || 0;
        if (i < 0) i += copy.length;
        if (i < 0 || i >= copy.length) throw new RangeError('Invalid index');
        copy[i] = value;
        return copy;
      }
    });
  }

  // 9. String.prototype.replaceAll (Chrome 85) & matchAll (Chrome 73)
  if (!String.prototype.replaceAll) {
    Object.defineProperty(String.prototype, 'replaceAll', {
      configurable: true, writable: true,
      value: function (search, replacement) {
        if (search instanceof RegExp) {
          if (!search.global) {
            throw new TypeError('String.prototype.replaceAll called with a non-global RegExp');
          }
          return this.replace(search, replacement);
        }
        return this.split(String(search)).join(replacement);
      }
    });
  }
  if (!String.prototype.matchAll) {
    Object.defineProperty(String.prototype, 'matchAll', {
      configurable: true, writable: true,
      value: function (regexp) {
        var flags = regexp instanceof RegExp ? regexp.flags : 'g';
        if (flags.indexOf('g') === -1) {
          throw new TypeError('String.prototype.matchAll called with a non-global RegExp');
        }
        var rx = new RegExp(regexp instanceof RegExp ? regexp.source : regexp, flags);
        var str = String(this);
        var matches = [];
        var match;
        while ((match = rx.exec(str)) !== null) {
          matches.push(match);
          if (match[0] === '') rx.lastIndex++;
        }
        return matches[Symbol.iterator]();
      }
    });
  }

  // 10. Promise.allSettled (Chrome 76), Promise.any (Chrome 85), Promise.withResolvers (Chrome 119)
  if (!Promise.allSettled) {
    Promise.allSettled = function (promises) {
      return Promise.all(Array.from(promises, function (p) {
        return Promise.resolve(p).then(
          function (value) { return { status: 'fulfilled', value: value }; },
          function (reason) { return { status: 'rejected', reason: reason }; }
        );
      }));
    };
  }
  if (typeof AggregateError === 'undefined') {
    globalThis.AggregateError = function AggregateError(errors, message) {
      var err = new Error(message || '');
      err.name = 'AggregateError';
      err.errors = Array.from(errors || []);
      return err;
    };
  }
  if (!Promise.any) {
    Promise.any = function (promises) {
      return new Promise(function (resolve, reject) {
        var arr = Array.from(promises);
        if (arr.length === 0) return reject(new globalThis.AggregateError([], 'All promises were rejected'));
        var errors = new Array(arr.length);
        var rejectedCount = 0;
        arr.forEach(function (p, idx) {
          Promise.resolve(p).then(resolve, function (err) {
            errors[idx] = err;
            rejectedCount++;
            if (rejectedCount === arr.length) {
              reject(new globalThis.AggregateError(errors, 'All promises were rejected'));
            }
          });
        });
      });
    };
  }
  if (!Promise.withResolvers) {
    Promise.withResolvers = function () {
      var resolve, reject;
      var promise = new Promise(function (res, rej) {
        resolve = res;
        reject = rej;
      });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }

  // 11. queueMicrotask (Chrome 71) & structuredClone (Chrome 98)
  if (typeof globalThis.queueMicrotask !== 'function') {
    var resolvedPromise = Promise.resolve();
    globalThis.queueMicrotask = function (callback) {
      resolvedPromise.then(callback).catch(function (err) {
        setTimeout(function () { throw err; }, 0);
      });
    };
  }
  if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = function structuredClone(value) {
      if (value === undefined || value === null || typeof value !== 'object') return value;
      if (value instanceof Date) return new Date(value.getTime());
      if (value instanceof RegExp) return new RegExp(value.source, value.flags);
      if (value instanceof Map) {
        var m = new Map();
        value.forEach(function (v, k) { m.set(structuredClone(k), structuredClone(v)); });
        return m;
      }
      if (value instanceof Set) {
        var s = new Set();
        value.forEach(function (v) { s.add(structuredClone(v)); });
        return s;
      }
      if (Array.isArray(value)) return value.map(structuredClone);
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return Object.assign({}, value);
      }
    };
  }

  // 12. URL.canParse (Chrome 120) & crypto.randomUUID (Chrome 92)
  if (typeof URL !== 'undefined' && !URL.canParse) {
    URL.canParse = function (url, base) {
      try {
        new URL(url, base);
        return true;
      } catch (_) {
        return false;
      }
    };
  }
  if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
    crypto.randomUUID = function () {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        var v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    };
  }

  // 13. DOM APIs ausentes no Chromium 68 (toggleAttribute Chrome 69, replaceChildren Chrome 86)
  if (typeof Element !== 'undefined') {
    if (!Element.prototype.toggleAttribute) {
      Element.prototype.toggleAttribute = function (name, force) {
        if (force !== undefined) force = !!force;
        if (this.hasAttribute(name)) {
          if (force) return true;
          this.removeAttribute(name);
          return false;
        }
        if (force === false) return false;
        this.setAttribute(name, '');
        return true;
      };
    }
    if (!Element.prototype.replaceChildren) {
      Element.prototype.replaceChildren = function () {
        while (this.lastChild) this.removeChild(this.lastChild);
        this.append.apply(this, arguments);
      };
    }
  }
  if (typeof Document !== 'undefined' && !Document.prototype.replaceChildren && typeof Element !== 'undefined') {
    Document.prototype.replaceChildren = Element.prototype.replaceChildren;
  }
  if (typeof DocumentFragment !== 'undefined' && !DocumentFragment.prototype.replaceChildren && typeof Element !== 'undefined') {
    DocumentFragment.prototype.replaceChildren = Element.prototype.replaceChildren;
  }

  // 14. AbortSignal.timeout (Chrome 103) & AbortSignal.any (Chrome 116)
  if (typeof AbortSignal !== 'undefined' && typeof AbortController !== 'undefined') {
    if (!AbortSignal.timeout) {
      AbortSignal.timeout = function (ms) {
        var controller = new AbortController();
        setTimeout(function () {
          controller.abort(new DOMException('Signal timed out', 'TimeoutError'));
        }, ms);
        return controller.signal;
      };
    }
  }
})();
