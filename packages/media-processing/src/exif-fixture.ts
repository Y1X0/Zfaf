/**
 * Builds a JPEG carrying a real EXIF block, including GPS coordinates.
 *
 * Written by hand rather than through an image library on purpose. Sharp's
 * `withExif` silently drops a GPS IFD and normalises orientation to 1, so a
 * fixture built with it would carry no GPS at all — and every "we stripped the
 * GPS" assertion downstream would pass while proving nothing. A test fixture
 * for a security property has to be verifiable, and the only way to be certain
 * these bytes are present is to place them.
 *
 * Structure produced (little-endian TIFF inside an APP1 segment):
 *
 *   FFE1 <len> "Exif\0\0"
 *   "II" 002A <offset:8>
 *   IFD0:  Make, Model, Orientation, GPSInfoIFDPointer
 *   GPS:   LatitudeRef, Latitude, LongitudeRef, Longitude
 *
 * Reference: EXIF 2.32, §4.6.
 */

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_GPS_IFD = 0x8825;

const GPS_LATITUDE_REF = 0x0001;
const GPS_LATITUDE = 0x0002;
const GPS_LONGITUDE_REF = 0x0003;
const GPS_LONGITUDE = 0x0004;

export interface ExifFixtureOptions {
  readonly make: string;
  readonly model: string;
  /** 1 = as shot, 6 = rotate 90° clockwise. */
  readonly orientation: number;
  /** Degrees, minutes, seconds — as a camera records them. */
  readonly latitude: readonly [number, number, number];
  readonly longitude: readonly [number, number, number];
  readonly latitudeRef: 'N' | 'S';
  readonly longitudeRef: 'E' | 'W';
}

/** One 12-byte IFD entry, plus any value too large to sit inline. */
interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Written into the entry's value field when ≤ 4 bytes. */
  readonly inline?: number;
  /** Written to the heap; the entry then holds its offset. */
  readonly heap?: Buffer;
}

function asciiValue(text: string): Buffer {
  // EXIF ASCII values are NUL-terminated and counted including the NUL.
  return Buffer.from(`${text}\u0000`, 'latin1');
}

function rationalValue(parts: readonly [number, number, number]): Buffer {
  const buffer = Buffer.alloc(24);
  parts.forEach((part, index) => {
    buffer.writeUInt32LE(Math.round(part * 1000), index * 8);
    buffer.writeUInt32LE(1000, index * 8 + 4);
  });
  return buffer;
}

/**
 * Serialises one IFD and its heap.
 *
 * `baseOffset` is where this IFD begins relative to the start of the TIFF
 * header, because every offset an entry stores is measured from there — the
 * detail that makes hand-written EXIF go wrong.
 */
function writeIfd(
  entries: readonly Entry[],
  baseOffset: number,
  nextIfdOffset: number,
): { readonly directory: Buffer; readonly heap: Buffer } {
  const directorySize = 2 + entries.length * 12 + 4;
  const directory = Buffer.alloc(directorySize);
  const heapParts: Buffer[] = [];
  let heapOffset = baseOffset + directorySize;

  directory.writeUInt16LE(entries.length, 0);

  entries.forEach((entry, index) => {
    const at = 2 + index * 12;
    directory.writeUInt16LE(entry.tag, at);
    directory.writeUInt16LE(entry.type, at + 2);
    directory.writeUInt32LE(entry.count, at + 4);

    if (entry.heap) {
      directory.writeUInt32LE(heapOffset, at + 8);
      heapParts.push(entry.heap);
      // Values are aligned to two bytes; an odd-length ASCII string pads.
      const padded = entry.heap.length % 2 === 0 ? 0 : 1;
      if (padded) heapParts.push(Buffer.alloc(1));
      heapOffset += entry.heap.length + padded;
    } else if (entry.type === TYPE_SHORT) {
      directory.writeUInt16LE(entry.inline ?? 0, at + 8);
      directory.writeUInt16LE(0, at + 10);
    } else {
      directory.writeUInt32LE(entry.inline ?? 0, at + 8);
    }
  });

  directory.writeUInt32LE(nextIfdOffset, 2 + entries.length * 12);
  return { directory, heap: Buffer.concat(heapParts) };
}

/** The APP1 segment: everything from the marker to the end of the GPS heap. */
export function buildExifSegment(options: ExifFixtureOptions): Buffer {
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(0x2a, 2);
  header.writeUInt32LE(8, 4); // IFD0 begins straight after the header.

  const makeValue = asciiValue(options.make);
  const modelValue = asciiValue(options.model);

  // The GPS IFD's position depends on how large IFD0 is, and IFD0 must store
  // that position — so IFD0 is laid out once to measure it, then written.
  const ifd0Entries: Entry[] = [
    { tag: TAG_MAKE, type: TYPE_ASCII, count: makeValue.length, heap: makeValue },
    { tag: TAG_MODEL, type: TYPE_ASCII, count: modelValue.length, heap: modelValue },
    { tag: TAG_ORIENTATION, type: TYPE_SHORT, count: 1, inline: options.orientation },
    { tag: TAG_GPS_IFD, type: TYPE_LONG, count: 1, inline: 0 },
  ];

  const measured = writeIfd(ifd0Entries, 8, 0);
  const gpsOffset = 8 + measured.directory.length + measured.heap.length;

  const ifd0 = writeIfd(
    ifd0Entries.map((entry) =>
      entry.tag === TAG_GPS_IFD ? { ...entry, inline: gpsOffset } : entry,
    ),
    8,
    0,
  );

  const latitudeRef = asciiValue(options.latitudeRef);
  const longitudeRef = asciiValue(options.longitudeRef);

  const gps = writeIfd(
    [
      // A two-byte ASCII value fits in the entry itself.
      {
        tag: GPS_LATITUDE_REF,
        type: TYPE_ASCII,
        count: 2,
        inline: latitudeRef.readUInt16LE(0),
      },
      {
        tag: GPS_LATITUDE,
        type: TYPE_RATIONAL,
        count: 3,
        heap: rationalValue(options.latitude),
      },
      {
        tag: GPS_LONGITUDE_REF,
        type: TYPE_ASCII,
        count: 2,
        inline: longitudeRef.readUInt16LE(0),
      },
      {
        tag: GPS_LONGITUDE,
        type: TYPE_RATIONAL,
        count: 3,
        heap: rationalValue(options.longitude),
      },
    ],
    gpsOffset,
    0,
  );

  const tiff = Buffer.concat([header, ifd0.directory, ifd0.heap, gps.directory, gps.heap]);
  const identifier = Buffer.from('Exif\u0000\u0000', 'latin1');
  const payload = Buffer.concat([identifier, tiff]);

  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  // The length field counts itself but not the marker.
  segment.writeUInt16BE(payload.length + 2, 2);

  return Buffer.concat([segment, payload]);
}

/**
 * Splices an EXIF segment into a JPEG, immediately after the start marker.
 *
 * That position is where a camera puts it and where every decoder looks first.
 */
export function attachExif(jpeg: Buffer, segment: Buffer): Buffer {
  if (jpeg.readUInt16BE(0) !== 0xffd8) {
    throw new Error('attachExif expects a JPEG (SOI marker missing)');
  }
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}
