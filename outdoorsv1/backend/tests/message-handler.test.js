import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, isRateLimited, extractPrompt, recordMessage } from '../src/message-handler.js';
import { config } from '../src/config.js';

describe('message-handler', () => {
  beforeEach(() => {
    config.prefix = '!claude ';
    config.allowAllNumbers = false;
    config.allowedNumbers = ['1234567890'];
    config.rateLimitPerMinute = 3;
  });

  describe('extractPrompt', () => {
    it('should extract prompt after prefix', () => {
      assert.equal(extractPrompt('!claude hello world'), 'hello world');
    });

    it('should return null for messages without prefix', () => {
      assert.equal(extractPrompt('hello world'), null);
    });

    it('should return null for empty text', () => {
      assert.equal(extractPrompt(null), null);
      assert.equal(extractPrompt(''), null);
    });

    it('should trim extracted prompt', () => {
      assert.equal(extractPrompt('!claude   spaced  '), 'spaced');
    });

    it('should return entire text when prefix is empty', () => {
      config.prefix = '';
      assert.equal(extractPrompt('hello world'), 'hello world');
    });
  });

  describe('isAllowed', () => {
    it('should allow numbers in the allowed list', () => {
      assert.equal(isAllowed('1234567890@s.whatsapp.net'), true);
    });

    it('should block numbers not in the allowed list', () => {
      assert.equal(isAllowed('9999999999@s.whatsapp.net'), false);
    });

    it('should allow all when allowAllNumbers is true', () => {
      config.allowAllNumbers = true;
      assert.equal(isAllowed('9999999999@s.whatsapp.net'), true);
    });
  });

  describe('isRateLimited', () => {
    it('should not rate limit first message', () => {
      assert.equal(isRateLimited('newuser@s.whatsapp.net'), false);
    });

    it('should rate limit after exceeding threshold', () => {
      const jid = 'ratelimituser@s.whatsapp.net';
      for (let i = 0; i < config.rateLimitPerMinute; i++) {
        recordMessage(jid);
      }
      assert.equal(isRateLimited(jid), true);
    });
  });
});
