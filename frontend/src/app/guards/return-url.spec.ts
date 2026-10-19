import {
  DEFAULT_AUTHENTICATED_URL,
  loginRedirectUrl,
  sanitizeReturnUrl
} from './return-url';

describe('return-url helpers', () => {
  describe('sanitizeReturnUrl()', () => {
    it('accepts same-app paths, including query strings and fragments', () => {
      expect(sanitizeReturnUrl('/chat')).toBe('/chat');
      expect(sanitizeReturnUrl('/documents?page=2#results')).toBe(
        '/documents?page=2#results'
      );
      expect(sanitizeReturnUrl('  /profile  ')).toBe('/profile');
    });

    it('rejects absolute external URLs', () => {
      expect(sanitizeReturnUrl('https://evil.example/steal')).toBeNull();
      expect(sanitizeReturnUrl('http://evil.example')).toBeNull();
      expect(sanitizeReturnUrl('javascript:alert(1)')).toBeNull();
      expect(sanitizeReturnUrl('mailto:user@example.com')).toBeNull();
    });

    it('rejects protocol-relative and backslash redirects', () => {
      expect(sanitizeReturnUrl('//evil.example')).toBeNull();
      expect(sanitizeReturnUrl('/\\evil.example')).toBeNull();
      expect(sanitizeReturnUrl('\\\\evil.example')).toBeNull();
    });

    it('rejects encoded external targets', () => {
      expect(sanitizeReturnUrl('/%2F%2Fevil.example')).toBeNull();
      expect(sanitizeReturnUrl('/%5Cevil.example')).toBeNull();
      expect(sanitizeReturnUrl('/%0Aheader-injection')).toBeNull();
    });

    it('rejects malformed percent-encoding and non-string input', () => {
      expect(sanitizeReturnUrl('/documents/%E0%A4%A')).toBeNull();
      expect(sanitizeReturnUrl(null)).toBeNull();
      expect(sanitizeReturnUrl(undefined)).toBeNull();
      expect(sanitizeReturnUrl('')).toBeNull();
    });

    it('rejects the auth pages themselves (no post-login loops)', () => {
      expect(sanitizeReturnUrl('/login')).toBeNull();
      expect(sanitizeReturnUrl('/login?returnUrl=%2Fchat')).toBeNull();
      expect(sanitizeReturnUrl('/register')).toBeNull();
    });
  });

  describe('loginRedirectUrl()', () => {
    it('encodes the captured target as a single query parameter', () => {
      expect(loginRedirectUrl('/documents?page=2')).toBe(
        '/login?returnUrl=%2Fdocuments%3Fpage%3D2'
      );
    });

    it('falls back to a bare /login when the target is missing or unsafe', () => {
      expect(loginRedirectUrl(null)).toBe('/login');
      expect(loginRedirectUrl('https://evil.example')).toBe('/login');
      expect(loginRedirectUrl('//evil.example')).toBe('/login');
    });
  });

  it('documents the default authenticated destination', () => {
    expect(DEFAULT_AUTHENTICATED_URL).toBe('/chat');
  });
});
