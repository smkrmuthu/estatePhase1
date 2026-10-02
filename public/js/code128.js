/**
 * CODE 128 (subset B) BARCODE ENCODER
 *
 * Package barcodes only contain A-Z, 0-9 and "-", so subset B covers them without
 * switching code sets. Output is an SVG string, so labels print sharply at any size
 * and nothing needs to be downloaded (works offline).
 */
const Code128 = (() => {
  // Module pattern for each symbol value 0..105, then STOP (with its termination bar).
  // "1" = bar module, "0" = space module.
  const PATTERNS = [
    "11011001100", "11001101100", "11001100110", "10010011000", "10010001100", "10001001100", "10011001000", "10011000100",
    "10001100100", "11001001000", "11001000100", "11000100100", "10110011100", "10011011100", "10011001110", "10111001100",
    "10011101100", "10011100110", "11001110010", "11001011100", "11001001110", "11011100100", "11001110100", "11101101110",
    "11101001100", "11100101100", "11100100110", "11101100100", "11100110100", "11100110010", "11011011000", "11011000110",
    "11000110110", "10100011000", "10001011000", "10001000110", "10110001000", "10001101000", "10001100010", "11010001000",
    "11000101000", "11000100010", "10110111000", "10110001110", "10001101110", "10111011000", "10111000110", "10001110110",
    "11101110110", "11010001110", "11000101110", "11011101000", "11011100010", "11011101110", "11101011000", "11101000110",
    "11100010110", "11101101000", "11101100010", "11100011010", "11101111010", "11001000010", "11110001010", "10100110000",
    "10100001100", "10010110000", "10010000110", "10000101100", "10000100110", "10110010000", "10110000100", "10011010000",
    "10011000010", "10000110100", "10000110010", "11000010010", "11001010000", "11110111010", "11000010100", "10001111010",
    "10100111100", "10010111100", "10010011110", "10111100100", "10011110100", "10011110010", "11110100100", "11110010100",
    "11110010010", "11011011110", "11011110110", "11110110110", "10101111000", "10100011110", "10001011110", "10111101000",
    "10111100010", "11110101000", "11110100010", "10111011110", "10111101110", "11101011110", "11110101110", "11010000100",
    "11010010000", "11010011100", "1100011101011",
  ];
  const START_B = 104;
  const STOP = 106;

  // Symbol values for the text, with start and checksum. Throws on characters outside subset B.
  function symbols(text) {
    const values = [START_B];
    for (const ch of String(text)) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code > 127) throw new Error(`Character "${ch}" cannot be encoded in Code 128B`);
      values.push(code - 32);
    }
    const checksum = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
    values.push(checksum, STOP);
    return values;
  }

  // The full module string ("1101001...") for the text.
  function modules(text) {
    return symbols(text).map(v => PATTERNS[v]).join("");
  }

  // SVG markup. moduleWidth/height are in SVG user units; quiet zone of 10 modules each side.
  function svg(text, { moduleWidth = 2, height = 60, quiet = 10 } = {}) {
    const bits = modules(text);
    const width = (bits.length + quiet * 2) * moduleWidth;
    let rects = "";
    for (let i = 0; i < bits.length; ) {
      if (bits[i] === "1") {
        let run = 1;
        while (bits[i + run] === "1") run++;
        rects += `<rect x="${(i + quiet) * moduleWidth}" y="0" width="${run * moduleWidth}" height="${height}"/>`;
        i += run;
      } else i++;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="barcode-svg" role="img" aria-label="Barcode ${text}"><rect width="${width}" height="${height}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }

  return { symbols, modules, svg };
})();

if (typeof module !== "undefined") module.exports = Code128;
