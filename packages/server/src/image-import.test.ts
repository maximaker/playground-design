import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canImportImage, isPrivateAddress } from './image-import.ts';

describe('image import guard', () => {
  it('accepts public https links', () => {
    assert.equal(canImportImage('https://images.unsplash.com/photo.jpg'), true);
    assert.equal(canImportImage('https://s3-alpha-sig.figma.com/img/abc'), true);
  });
  it('refuses http, credentials and internal hosts', () => {
    for (const u of ['http://example.com/a.png', 'https://user:pw@example.com/a.png', 'https://localhost/a.png',
      'https://127.0.0.1/a.png', 'https://10.0.0.5/a.png', 'https://169.254.169.254/latest', 'https://[::1]/a.png',
      'https://192.168.1.1/a.png', 'https://172.20.0.1/a.png', 'https://[::ffff:127.0.0.1]/a.png', 'notaurl']) {
      assert.equal(canImportImage(u), false, u);
    }
  });
  it('classifies addresses', () => {
    assert.equal(isPrivateAddress('8.8.8.8'), false);
    assert.equal(isPrivateAddress('100.64.0.1'), true);
    assert.equal(isPrivateAddress('fd00::1'), true);
    assert.equal(isPrivateAddress('2606:4700::1'), false);
  });
});
