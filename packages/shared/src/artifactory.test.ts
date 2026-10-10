import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactoryEmbedUrl } from './artifactory.ts';

test('turns a share link into the chrome-less embed link', () => {
  assert.equal(artifactoryEmbedUrl('https://art.example.com/#/s/abc123'), 'https://art.example.com/#/e/abc123');
  assert.equal(artifactoryEmbedUrl('http://localhost:5180/#/s/a_b-c'), 'http://localhost:5180/#/e/a_b-c');
});

test('leaves an embed link as it is', () => {
  assert.equal(artifactoryEmbedUrl('https://art.example.com/#/e/abc'), 'https://art.example.com/#/e/abc');
});

test('builds from a bare slug only when given an origin', () => {
  assert.equal(artifactoryEmbedUrl('abc', 'https://art.example.com/'), 'https://art.example.com/#/e/abc');
  assert.equal(artifactoryEmbedUrl('abc'), null);
});

test('refuses anything that is not a share link', () => {
  assert.equal(artifactoryEmbedUrl('https://art.example.com/#/a/abc'), null);
  assert.equal(artifactoryEmbedUrl('javascript:alert(1)//#/s/abc'), null);
  assert.equal(artifactoryEmbedUrl('not a url'), null);
});
