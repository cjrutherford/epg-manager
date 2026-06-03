import { setOpenCorsHeaders } from '../http-headers';

function createMockResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      setHeader(name: string, value: string) {
        headers.set(name, value);
      }
    } as any
  };
}

describe('http headers', () => {
  it('allows any origin and exposes media range headers', () => {
    const { res, headers } = createMockResponse();

    setOpenCorsHeaders({ headers: {} } as any, res);

    expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(headers.get('Access-Control-Allow-Headers')).toContain('Range');
    expect(headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });

  it('reflects requested preflight headers for proxy and browser variations', () => {
    const { res, headers } = createMockResponse();

    setOpenCorsHeaders({
      headers: { 'access-control-request-headers': 'authorization,range,x-custom-header' }
    } as any, res);

    expect(headers.get('Access-Control-Allow-Headers')).toBe('authorization,range,x-custom-header');
  });
});

