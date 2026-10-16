import test from 'node:test';
import assert from 'node:assert/strict';
import { fileTreeLabel } from '../src/ui/file-tree-label.ts';
import { attachmentType, isImage } from '../src/ui/attachments.ts';

const label = (path: string) => fileTreeLabel({path, type:'file'});

test('recognized note, structured, image and media suffixes are hidden case-insensitively', () => {
  const extensions = ['md','pdf','canvas','base','png','jpg','jpeg','gif','webp','svg','bmp','avif',
    'mp3','wav','m4a','3gp','flac','ogg','oga','opus','mp4','webm','ogv','mov','mkv'];
  for (const extension of extensions) {
    assert.equal(label(`Folder/Report.v2.${extension}`),'Report.v2');
    assert.equal(label(`Folder/Report.v2.${extension.toUpperCase()}`),'Report.v2');
  }
});

test('unknown extensions retain original spelling and folders retain all dots', () => {
  for (const filename of ['Archive.tar.gz','Script.JS','Data.json','Notes.txt','Document.docx','Almost.bases','Audio.aac','Picture.heic','README','png','Name.','.md']) {
    assert.equal(label(`Folder/${filename}`),filename);
  }
  for (const name of ['Projects.md','Photos.png','Notes.base','Audio.mp3']) {
    assert.equal(fileTreeLabel({path:`Parent/${name}`,type:'folder'}),name);
  }
});

test('path punctuation and display names do not masquerade as filename extensions', () => {
  assert.equal(label('Folder.pdf/Plain'),'Plain');
  assert.equal(label('Folder.mp3/Plain.xyz'),'Plain.xyz');
  assert.equal(label('Folder/Readme.md.backup'),'Readme.md.backup');
  assert.equal(label('Folder/My.canvas.PDF'),'My.canvas');
});


test('unknown suffixes cannot resolve inherited MIME table properties', () => {
  for (const filename of ['File.constructor','File.CONSTRUCTOR','File.__proto__','File.toString']) {
    assert.equal(label(filename),filename);
    assert.equal(attachmentType(filename),'application/octet-stream');
    assert.equal(isImage(filename),false);
  }
});
