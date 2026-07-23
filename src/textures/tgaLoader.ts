// © 2026 lizard.build — https://lizard.build — All rights reserved. See LICENSE.
/**
 * Minimal TGA decoder for Minecraft Bedrock block textures.
 * Supports type 2 (uncompressed RGBA/RGB) and type 10 (RLE RGBA/RGB).
 * Returns an ImageData-compatible { width, height, data: Uint8ClampedArray }.
 */
export async function loadTGA(url: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const resp = await fetch(url);
  const buf  = await resp.arrayBuffer();
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const idLength    = bytes[0];
  const imageType   = bytes[2];  // 2 = uncompressed, 10 = RLE
  const width       = view.getUint16(12, true);
  const height      = view.getUint16(14, true);
  const pixelDepth  = bytes[16]; // 24 or 32
  const descriptor  = bytes[17];
  const topToBottom = (descriptor & 0x20) !== 0;
  const bytesPerPx  = pixelDepth >> 3; // 3 or 4

  // Skip header (18) + ID + color map (always 0 length for these textures)
  let offset = 18 + idLength;

  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);

  function writePixel(idx: number, src: Uint8Array, srcOff: number) {
    // TGA stores pixels as BGR or BGRA — swap to RGBA
    rgba[idx * 4 + 0] = src[srcOff + 2]; // R
    rgba[idx * 4 + 1] = src[srcOff + 1]; // G
    rgba[idx * 4 + 2] = src[srcOff + 0]; // B
    rgba[idx * 4 + 3] = bytesPerPx === 4 ? src[srcOff + 3] : 255;
  }

  if (imageType === 2) {
    // Uncompressed
    for (let i = 0; i < pixelCount; i++) {
      writePixel(i, bytes, offset);
      offset += bytesPerPx;
    }
  } else if (imageType === 10) {
    // RLE compressed
    let i = 0;
    while (i < pixelCount) {
      const packet = bytes[offset++];
      const count  = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        // Run-length: repeat one pixel `count` times
        for (let r = 0; r < count; r++) writePixel(i + r, bytes, offset);
        offset += bytesPerPx;
      } else {
        // Raw: `count` individual pixels
        for (let r = 0; r < count; r++) {
          writePixel(i + r, bytes, offset);
          offset += bytesPerPx;
        }
      }
      i += count;
    }
  } else {
    throw new Error(`Unsupported TGA image type: ${imageType}`);
  }

  // TGA default origin is bottom-left; flip vertically if not top-to-bottom
  if (!topToBottom) {
    const row = new Uint8ClampedArray(width * 4);
    for (let y = 0; y < height >> 1; y++) {
      const a = y * width * 4;
      const b = (height - 1 - y) * width * 4;
      row.set(rgba.subarray(a, a + width * 4));
      rgba.copyWithin(a, b, b + width * 4);
      rgba.set(row, b);
    }
  }

  return { width, height, data: rgba };
}
