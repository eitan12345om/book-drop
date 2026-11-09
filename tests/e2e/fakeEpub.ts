const ZIP_END_RECORD = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

export function fakeEpub(text = 'fake epub'): Buffer {
  return Buffer.concat([Buffer.from(text), ZIP_END_RECORD]);
}
