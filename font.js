
/*!
 * font.js — robust PDF font discovery, extraction, and cache installer (Blob-based)
 * Drop this before your renderer; call PDFEmbeddedFonts.cacheFontsFromResources(...)
 * Uses Blob URLs instead of base64 data URIs.
 *
 * Works with:
 *  - Type0 (CID-based) /Identity-H or V with /CIDFontType0/2 descendants
 *  - Type1, MMType1
 *  - TrueType (Type42) and CIDFontType2 embedded as FontFile2
 *  - Type3 (no font file; renderer must paint glyph procs)
 *  - ToUnicode CMaps (bfchar/bfrange) for text extraction
 *  - Widths via /W arrays and /DW for CID fonts
 *
 * Expected context object (ctx):
 *  {
 *    objects: Map,                    // key "num gen" -> { num, gen, dict, raw, decoded, ... }
 *    xrefEntries: Map,                // from your parser (for lazy /ObjStm expansion)
 *    fileBytes: Uint8Array,           // entire PDF bytes
 *    fileText: string,                // entire PDF as latin1 string
 *    processObjStmIfNeeded(num,gen): Promise<void>,
 *    extractAndDecodeStream(obj, bytes, text): Promise<void>,
 *    debugInfo: string[]              // push strings for diagnostics (optional)
 *  }
 *
 * Usage (replace your old cacheFontsFromResources):
 *    const F = PDFEmbeddedFonts;
 *    await F.cacheFontsFromResources(resourcesDict, pageKey, ctx, fontCache);
 *
 * The fontCache is a Map you own: key -> {
 *   type, name, encoding, ttf (Uint8Array|undefined), url (string|undefined),
 *   toUnicode, widths, defaultWidth, writingMode
 * }
 *
 * NOTE: This file is designed to be framework-agnostic and only touches window + document.
 */
(function (global) {
  const PDFEmbeddedFonts = {};

  function log(ctx, msg) { try { if (ctx?.debugInfo) ctx.debugInfo.push(msg); } catch (_) {} }

  function latin1ToUint8(latin1) {
    const out = new Uint8Array(latin1.length);
    for (let i = 0; i < latin1.length; i++) out[i] = latin1.charCodeAt(i) & 0xFF;
    return out;
  }

  function uint8ToLatin1(u8) {
    let s = ""; // used rarely (diagnostics)
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  /** Minimal, permissive name extractor: /Key /Value */
  function readName(dict, key, dflt=null) {
    const m = dict && dict.match(new RegExp("\\/"+key+"\\s*\\/([^\\s/>\\[]+)", "m"));
    return m ? m[1] : dflt;
  }
  /** Indirect ref finder: /Key 12 0 R */
  function readRef(dict, key) {
    const m = dict && dict.match(new RegExp("\\/"+key+"\\s*(\\d+)\\s+(\\d+)\\s+R"));
    return m ? { num: +m[1], gen: +m[2] } : null;
  }
  /** Number value: /Key 123 or /Key -123.45 */
  function readNumber(dict, key, dflt=null) {
    const m = dict && dict.match(new RegExp("\\/"+key+"\\s+(-?\\d+(?:\\.\\d+)?)"));
    return m ? parseFloat(m[1]) : dflt;
  }
  /** Boolean flag in /Flags bitfield */
  function hasFlag(flags, bit){ return ((flags|0) & bit) !== 0; }

  // ---- ToUnicode parsing (bfchar / bfrange, with codespace length detection) ----
  function parseToUnicodeCMap(cmapText) {
    if (!cmapText) return null;
    let bytesPerChar = 1;

    // Figure out max codespace length
    const csr = /begincodespacerange([\s\S]*?)endcodespacerange/gm;
    let m;
    while ((m = csr.exec(cmapText))) {
      const body = m[1];
      const pairs = body.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || [];
      for (const p of pairs) {
        const mm = p.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
        if (mm) bytesPerChar = Math.max(bytesPerChar, Math.ceil(mm[1].length / 2));
      }
    }

    const map = Object.create(null);

    function hexToCode(hex) { return parseInt(hex, 16) >>> 0; }
    function hexToUnicodeText(hex){
      // Interpret as big-endian UTF-16 code units (common for ToUnicode)
      const bytes = hex.match(/../g)?.map(h=>parseInt(h,16)) || [];
      let s = '';
      for (let i=0; i<bytes.length; i+=2) {
        const u = ((bytes[i] << 8) | (bytes[i+1]||0)) >>> 0;
        if (u) s += String.fromCharCode(u);
      }
      return s;
    }

    const bfchar = /beginbfchar([\s\S]*?)endbfchar/gm;
    while ((m = bfchar.exec(cmapText))) {
      const lines = m[1].split(/\r?\n/);
      for (const ln of lines) {
        const mm = ln.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
        if (!mm) continue;
        map[hexToCode(mm[1])] = hexToUnicodeText(mm[2]);
      }
    }

    const bfrange = /beginbfrange([\s\S]*?)endbfrange/gm;
    while ((m = bfrange.exec(cmapText))) {
      const lines = m[1].split(/\r?\n/);
      for (const ln of lines) {
        let mm = ln.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
        if (mm) {
          const s = hexToCode(mm[1]), e = hexToCode(mm[2]);
          const dst0Hex = mm[3];
          // Common case: one UTF-16 unit, then sequential increment
          if (dst0Hex.length === 4) {
            const dst0 = hexToCode(dst0Hex);
            for (let c = s; c <= e; c++) map[c] = String.fromCharCode(dst0 + (c - s));
          } else {
            // Fallback: just map start
            map[s] = hexToUnicodeText(dst0Hex);
          }
          continue;
        }
        mm = ln.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]+)\]/);
        if (mm) {
          const s = hexToCode(mm[1]), e = hexToCode(mm[2]);
          const list = mm[3].match(/<([0-9A-Fa-f]+)>/g) || [];
          for (let i=0; i<list.length && s+i<=e; i++) {
            const h = list[i].slice(1,-1);
            map[s+i] = hexToUnicodeText(h);
          }
        }
      }
    }
    return { map, bytesPerChar };
  }

  // ---- Blob-based font installer ----
  const installed = new Set();
  function cssEscape(s){ return String(s).replace(/(['"\\])/g, '\\$1'); }

  function installEmbeddedFontCssBlob(fontFamily, binary, mimeGuess) {
    if (!binary || installed.has(fontFamily)) return null;
    installed.add(fontFamily);
    // Default MIME guesses: FontFile2 -> TrueType/OpenType with TTF flavor
    const mime = mimeGuess || 'font/ttf';
    const blob = new Blob([binary], { type: mime });
    const url = URL.createObjectURL(blob);
    const css = `@font-face{
      font-family:'${cssEscape(fontFamily)}';
      src:url(${url}) format('truetype');
      font-weight:normal; font-style:normal; font-display:swap; }`;

    let el = document.getElementById('pdf-embedded-fonts-blob');
    if (!el) { el = document.createElement('style'); el.id = 'pdf-embedded-fonts-blob'; document.head.appendChild(el); }
    el.appendChild(document.createTextNode(css));
    return url;
  }

  // ---- Width table (/W and /DW) for CID fonts ----
  function parseCIDWidths(fontDict) {
    const widths = Object.create(null);
    let defaultWidth = readNumber(fontDict, "DW", 1000);

    const wMatch = fontDict && fontDict.match(/\/W\s*\[([\s\S]*?)\]/);
    if (!wMatch) return { widths, defaultWidth };
    const body = wMatch[1].trim();
    // Grammar: c [w1 w2 ...]  |  cFirst cLast w  |  (repeated)
    // We'll tokenize numbers and brackets
    const tokens = [];
    body.replace(/(\[|\]|-?\d+\.?\d*)/g, (m, x) => { tokens.push(x); return m; });

    let i = 0;
    function readNumberTok(){ return parseFloat(tokens[i++]); }

    while (i < tokens.length) {
      const cFirst = readNumberTok(); if (!isFinite(cFirst)) break;
      const next = tokens[i++];
      if (next === '[') {
        let c = cFirst;
        while (i < tokens.length && tokens[i] !== ']') {
          const w = parseFloat(tokens[i++]);
          if (isFinite(w)) widths[c++] = w;
          else break;
        }
        if (tokens[i] === ']') i++;
      } else {
        // It's a single number -> means cFirst is actually cLast, and 'next' was a number (the individual w)
        const cLast = parseFloat(next);
        const w = parseFloat(tokens[i++]);
        if (isFinite(cLast) && isFinite(w)) {
          for (let c = cFirst; c <= cLast; c++) widths[c] = w;
        }
      }
    }
    return { widths, defaultWidth };
  }

  // ---- Extract embedded font file (FontFile, FontFile2, FontFile3) ----
  async function extractEmbeddedFontBinary(descriptorObj, ctx) {
    if (!descriptorObj?.dict) return null;
    const dict = descriptorObj.dict;

    // FontFile2 (TrueType / CIDFontType2)
    let ref = readRef(dict, 'FontFile2');
    let mime = 'font/ttf';
    if (!ref) {
      // Type1 (FontFile) or CFF (FontFile3 with /Subtype /Type1C or /CIDFontType0C)
      ref = readRef(dict, 'FontFile');
      if (ref) mime = 'font/type1';
      else {
        ref = readRef(dict, 'FontFile3');
        if (ref) {
          // Crude subtype detection
          const sub = dict.match(/\/FontFile3\s+\d+\s+\d+\s+R[\s\S]*?>>/);
          if (sub && /\/Subtype\s*\/Type1C\b/.test(sub[0])) mime = 'font/otf';
          else if (sub && /\/Subtype\s*\/CIDFontType0C\b/.test(sub[0])) mime = 'font/otf';
          else mime = 'application/octet-stream';
        }
      }
    }
    if (!ref) return null;

    await ctx.processObjStmIfNeeded(ref.num, ref.gen);
    const fileObj = ctx.objects.get(ref.num + " " + ref.gen);
    if (!fileObj) return null;
    if (!fileObj.processed) {
      await ctx.extractAndDecodeStream(fileObj, ctx.fileBytes, ctx.fileText);
      fileObj.processed = true;
    }
    if (!fileObj.decoded) return null;

    return { bytes: latin1ToUint8(fileObj.decoded), mime };
  }

  function stripSubsetPrefix(name) {
    return String(name || '').replace(/^[A-Z]{6}\+/, '');
  }

  function detectWritingMode(encodingName) {
    // Identity-V is vertical; everything else treat as horizontal
    return (/Identity-V\b/.test(encodingName || '') ? 'vertical' : 'horizontal');
  }

  function decodeToUnicodeRef(ref, ctx) {
    return (async () => {
      if (!ref) return null;
      await ctx.processObjStmIfNeeded(ref.num, ref.gen);
      const obj = ctx.objects.get(ref.num + " " + ref.gen);
      if (!obj) return null;
      if (!obj.processed) {
        await ctx.extractAndDecodeStream(obj, ctx.fileBytes, ctx.fileText);
        obj.processed = true;
      }
      return obj?.decoded ? parseToUnicodeCMap(obj.decoded) : null;
    })();
  }

  async function buildFontEntry(fontKey, fontDictStr, ctx) {
    const subtype = readName(fontDictStr, 'Subtype', 'Unknown');
    const baseName = readName(fontDictStr, 'BaseFont', fontKey);
    const encodingName = readName(fontDictStr, 'Encoding', 'StandardEncoding');
    const toUnicodeRef = readRef(fontDictStr, 'ToUnicode');

    let toUnicode = await decodeToUnicodeRef(toUnicodeRef, ctx);
    let ttfBytes = null, blobUrl = null, mime = null;
    let widths = null, defaultWidth = null;
    let writingMode = detectWritingMode(encodingName);

    if (subtype === 'Type0') {
      // Composite font with DescendantFonts
      const descArr = fontDictStr.match(/\/DescendantFonts\s*\[([^\]]+)\]/);
      const firstRef = descArr && descArr[1].match(/(\d+)\s+(\d+)\s+R/);
      if (firstRef) {
        await ctx.processObjStmIfNeeded(+firstRef[1], +firstRef[2]);
        const descObj = ctx.objects.get(firstRef[1] + " " + firstRef[2]);
        if (descObj?.dict) {
          const cidSubtype = readName(descObj.dict, 'Subtype', '');
          // Widths for CID fonts
          const wd = parseCIDWidths(descObj.dict);
          widths = wd.widths; defaultWidth = wd.defaultWidth;
          // Descriptor for embedded font
          const descriptorRef = readRef(descObj.dict, 'FontDescriptor');
          if (descriptorRef) {
            await ctx.processObjStmIfNeeded(descriptorRef.num, descriptorRef.gen);
            const descriptorObj = ctx.objects.get(descriptorRef.num + " " + descriptorRef.gen);
            if (descriptorObj) {
              const embedded = await extractEmbeddedFontBinary(descriptorObj, ctx);
              if (embedded) {
                ttfBytes = embedded.bytes;
                mime = embedded.mime;
              }
            }
          }
        }
      }
    } else if (subtype === 'Type1' || subtype === 'MMType1' || subtype === 'TrueType') {
      // Simple fonts: look for /FontDescriptor -> FontFile*, widths are in /Widths (not handled here—renderer may not need exact widths)
      const descriptorRef = readRef(fontDictStr, 'FontDescriptor');
      if (descriptorRef) {
        await ctx.processObjStmIfNeeded(descriptorRef.num, descriptorRef.gen);
        const descriptorObj = ctx.objects.get(descriptorRef.num + " " + descriptorRef.gen);
        if (descriptorObj) {
          const embedded = await extractEmbeddedFontBinary(descriptorObj, ctx);
          if (embedded) {
            ttfBytes = embedded.bytes;
            mime = embedded.mime;
          }
        }
      }
    } else if (subtype === 'Type3') {
      // No embedded sfnt — glyphs are painted from content streams. Keep toUnicode if present.
    } else {
      // Unknown / other: still try a descriptor
      const descriptorRef = readRef(fontDictStr, 'FontDescriptor');
      if (descriptorRef) {
        await ctx.processObjStmIfNeeded(descriptorRef.num, descriptorRef.gen);
        const descriptorObj = ctx.objects.get(descriptorRef.num + " " + descriptorRef.gen);
        if (descriptorObj) {
          const embedded = await extractEmbeddedFontBinary(descriptorObj, ctx);
          if (embedded) {
            ttfBytes = embedded.bytes;
            mime = embedded.mime;
          }
        }
      }
    }

    // Install CSS if we have font bytes
    const family = stripSubsetPrefix(baseName);
    if (ttfBytes) {
      blobUrl = installEmbeddedFontCssBlob(family, ttfBytes, mime);
    }

    return {
      type: subtype,
      name: baseName,
      family,
      encoding: encodingName,
      ttf: ttfBytes || undefined,
      url: blobUrl || undefined,
      mime: mime || undefined,
      toUnicode: toUnicode || undefined,
      widths: widths || undefined,
      defaultWidth: defaultWidth || undefined,
      writingMode
    };
  }

  // Robust /Font dictionary collector that accepts inline dict, array refs, or bare refs
  function findFontContainer(resourcesDict) {
    const m = resourcesDict.match(/\/Font\s*(<<[\s\S]*?>>|<[^>]*\d+\s+\d+\s+R[^>]*>|\[[^\]]*?\]|\d+\s+\d+\s+R)/);
    return m ? m[1] : null;
  }

  function eachFontEntry(fontContainerStr, cb) {
    // Entries can be inline dict OR <…R> OR plain "4 0 R"
    const entryRe = /\/([A-Za-z0-9\-\+]+)\s*(?:(<<[\s\S]*?>>)|(<[^>]*(\d+)\s+(\d+)\s+R[^>]*>)|((\d+)\s+(\d+)\s+R))/g;
    let m;
    while ((m = entryRe.exec(fontContainerStr))) {
      const tag = m[1];
      const inlineBody = m[2];
      const refNum = m[4] ? +m[4] : (m[7] ? +m[7] : null);
      const refGen = m[5] ? +m[5] : (m[8] ? +m[8] : null);
      cb({ tag, inlineBody, refNum, refGen });
    }
  }

  async function getDictFromRef(num, gen, ctx) {
    await ctx.processObjStmIfNeeded(num, gen);
    const obj = ctx.objects.get(num + " " + gen);
    return obj?.dict || null;
  }

  /**
   * cacheFontsFromResources(resourcesDict, pageKey, ctx, fontCache)
   * - Parses /Font entries and populates the provided fontCache (Map).
   * - Installs embedded fonts via Blob @font-face.
   */
  PDFEmbeddedFonts.cacheFontsFromResources = async function(resourcesDict, pageKey, ctx, fontCache) {
    log(ctx, `[Font] Raw /Resources for page ${pageKey}: ${resourcesDict?.slice(0, 2000) || ''}`);

    let fontContainer = findFontContainer(resourcesDict || '');
    if (!fontContainer) {
      log(ctx, `[Font] No /Font dictionary in resources for page ${pageKey}`);
      return;
    }

    // If /Font is a bare ref, resolve it
    const refOnly = fontContainer.replace(/[<>\[\]]/g, ' ').match(/(^|\s)(\d+)\s+(\d+)\s+R(?=\s|$)/);
    if (refOnly) {
      const objNum = +refOnly[2], genNum = +refOnly[3];
      const dict = await getDictFromRef(objNum, genNum, ctx);
      if (!dict) {
        log(ctx, `[Font] /Font ref ${objNum} ${genNum} not found for page ${pageKey}`);
        return;
      }
      fontContainer = dict;
      log(ctx, `[Font] /Font resolved to dict of ${objNum} ${genNum}`);
    }

    let found = 0;
    await (async () => {
      const jobs = [];
      eachFontEntry(fontContainer, ({ tag, inlineBody, refNum, refGen }) => {
        jobs.push((async () => {
          let fontDictStr = inlineBody || null;
          if (!fontDictStr && refNum != null) {
            fontDictStr = await getDictFromRef(refNum, refGen, ctx);
            if (!fontDictStr) {
              log(ctx, `[Font] Font ${tag} -> ${refNum} ${refGen} not found`);
              return;
            }
          }
          if (!fontDictStr) return;
          const entry = await buildFontEntry(tag, fontDictStr, ctx);
          fontCache.set(tag, entry);
          found++;
          const kind = entry.ttf ? `${entry.mime||'font'}/${entry.ttf.length}b` : 'no-embed';
          log(ctx, `[Font] Cached ${tag}: ${entry.type} ${entry.name} (${kind})`);
        })());
      });
      await Promise.all(jobs);
    })();

    if (!found) log(ctx, `[Font] /Font parsed but no entries discovered on page ${pageKey}`);
    else       log(ctx, `[Font] Parsed ${found} fonts on page ${pageKey}`);
  };

  // Export helpers if desired
  PDFEmbeddedFonts.parseToUnicodeCMap = parseToUnicodeCMap;
  PDFEmbeddedFonts.installEmbeddedFontCssBlob = installEmbeddedFontCssBlob;
  PDFEmbeddedFonts.parseCIDWidths = parseCIDWidths;
  PDFEmbeddedFonts.installEmbeddedFontCss = installEmbeddedFontCssBlob; // Alias for compatibility

  // Attach to window/global
  global.PDFEmbeddedFonts = PDFEmbeddedFonts;

})(typeof window !== 'undefined' ? window : globalThis);
